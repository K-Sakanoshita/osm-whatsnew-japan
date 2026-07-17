<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("sync.php is available from cron/CLI only.\n");
}

set_time_limit(240);
ini_set('default_socket_timeout', '30');

// Prevent the next cron invocation from starting while this one is active.
$lockPath = sys_get_temp_dir() . '/whatsnew-sync-' . sha1(__DIR__) . '.lock';
$lockHandle = fopen($lockPath, 'c');
if ($lockHandle === false || !flock($lockHandle, LOCK_EX | LOCK_NB)) {
    exit("sync skipped: another process is still running.\n");
}

$config = require __DIR__ . '/bootstrap.php';
$db = $config['db'];
$pdo = new PDO(
    "mysql:host={$db['host']};dbname={$db['dbname']};charset={$db['charset']}",
    $db['user'],
    $db['pass'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

// The changeset API accepts a rectangular bbox, so the Japan-wide bbox also
// overlaps nearby countries. Reject those land areas before saving while
// preserving Japan's western islands, Hokkaido and the remote Pacific islands.
$isExcludedForeignArea = static function (float $lat, float $lon): bool {
    $isKoreanMainland = $lat >= 34.7 && $lat <= 43.1 && $lon >= 124.0 && $lon <= 130.8;
    $isKoreanSouthernIslands = $lat >= 32.8 && $lat < 34.7 && $lon >= 124.5 && $lon < 128.3;
    $isChinaEastCoast = $lat >= 25.0 && $lat < 39.0 && $lon < 123.0;
    $isChinaOrRussianMainland = $lat >= 39.0 && $lon < 139.2;
    $isRussianNorth = $lat > 45.6;
    $isRussianKurilsNorth = $lat >= 44.5 && $lon >= 146.0;
    $isRussianKurilsSouth = $lat >= 43.5 && $lon >= 146.5;

    return $isKoreanMainland
        || $isKoreanSouthernIslands
        || $isChinaEastCoast
        || $isChinaOrRussianMainland
        || $isRussianNorth
        || $isRussianKurilsNorth
        || $isRussianKurilsSouth;
};

// Older installations limited category to ENUM('amenity','shop').  Any OSM
// tag key can now be used as the representative category, so widen the two
// display columns once when this version is first run.
$categoryColumn = $pdo->query("SHOW COLUMNS FROM osm_poi LIKE 'category'")->fetch(PDO::FETCH_ASSOC);
if ($categoryColumn && str_starts_with(strtolower((string) $categoryColumn['Type']), 'enum(')) {
    $pdo->exec('ALTER TABLE osm_poi MODIFY category VARCHAR(255) NOT NULL, MODIFY category_value VARCHAR(255) NULL');
}

// Remove foreign rows stored by older versions once. The state flag avoids a
// full-table DELETE check on every six-minute cron invocation.
$foreignFilterVersion = '2026-07-14-1';
$savedForeignFilterVersion = $pdo->query("SELECT state_value FROM osm_sync_state WHERE state_key='foreign_filter_version'")->fetchColumn();
$foreignRemoved = 0;
if ($savedForeignFilterVersion !== $foreignFilterVersion) {
    $foreignRemoved = $pdo->exec(
        'DELETE FROM osm_poi WHERE '
        . '(latitude >= 34.7 AND latitude <= 43.1 AND longitude >= 124.0 AND longitude <= 130.8) OR '
        . '(latitude >= 32.8 AND latitude < 34.7 AND longitude >= 124.5 AND longitude < 128.3) OR '
        . '(latitude >= 25.0 AND latitude < 39.0 AND longitude < 123.0) OR '
        . '(latitude >= 39.0 AND longitude < 139.2) OR '
        . '(latitude > 45.6) OR '
        . '(latitude >= 44.5 AND longitude >= 146.0) OR '
        . '(latitude >= 43.5 AND longitude >= 146.5)'
    );
    $pdo->prepare("INSERT INTO osm_sync_state (state_key,state_value) VALUES ('foreign_filter_version',?) ON DUPLICATE KEY UPDATE state_value=VALUES(state_value)")
        ->execute([$foreignFilterVersion]);
}

$cursorValue = $pdo->query("SELECT state_value FROM osm_sync_state WHERE state_key='sync_cursor_at'")->fetchColumn();
if (!$cursorValue) {
    // Migrate the cursor written by the previous version under a misleading key.
    $cursorValue = $pdo->query("SELECT state_value FROM osm_sync_state WHERE state_key='last_sync_at'")->fetchColumn();
    if ($cursorValue) {
        $pdo->prepare("INSERT INTO osm_sync_state (state_key,state_value) VALUES ('sync_cursor_at',?) ON DUPLICATE KEY UPDATE state_value=VALUES(state_value)")->execute([$cursorValue]);
        $pdo->exec("DELETE FROM osm_sync_state WHERE state_key='last_sync_at'");
    }
}
$upsert = $pdo->prepare('INSERT INTO osm_poi (osm_type,osm_id,name,category,category_value,latitude,longitude,tags,osm_timestamp,changeset_id,editor_uid,editor_name,change_action,created_osm_at,creator_uid,creator_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),category_value=VALUES(category_value),latitude=VALUES(latitude),longitude=VALUES(longitude),tags=VALUES(tags),osm_timestamp=VALUES(osm_timestamp),changeset_id=VALUES(changeset_id),editor_uid=VALUES(editor_uid),editor_name=VALUES(editor_name),change_action=VALUES(change_action),created_osm_at=COALESCE(created_osm_at,VALUES(created_osm_at)),creator_uid=COALESCE(creator_uid,VALUES(creator_uid)),creator_name=COALESCE(creator_name,VALUES(creator_name))');
$deletePoi = $pdo->prepare("DELETE FROM osm_poi WHERE osm_type='node' AND osm_id=?");
$saveCursor = $pdo->prepare("INSERT INTO osm_sync_state (state_key,state_value) VALUES ('sync_cursor_at',?) ON DUPLICATE KEY UPDATE state_value=VALUES(state_value)");
$saveCompleted = $pdo->prepare("INSERT INTO osm_sync_state (state_key,state_value) VALUES ('last_sync_at',?) ON DUPLICATE KEY UPDATE state_value=VALUES(state_value)");

// Use only the main OSM API. The saved cursor lets cron resume the backfill.
$cursor = $cursorValue ? strtotime($cursorValue) : time() - 14 * 24 * 60 * 60;
$target = time();
$startedAt = microtime(true);
$minimumWindows = 3;
$normalTimeLimit = 180;
$hardTimeLimit = 230;
$windows = 0;
$changesets = 0;
$saved = 0;
$removed = 0;
$bbox = array_map('floatval', explode(',', $config['bbox']));
[$minLon, $minLat, $maxLon, $maxLat] = $bbox;
$categoryPriority = [
    'amenity', 'shop', 'tourism', 'historic', 'leisure', 'golf', 'office',
    'craft', 'man_made', 'public_transport', 'healthcare',
    'emergency', 'sport', 'highway', 'traffic_calming', 'railway', 'aeroway', 'place',
    'natural', 'landuse', 'building', 'power', 'waterway', 'barrier',
    'route', 'entrance', 'name',
];

while (
    $cursor < $target
    && microtime(true) - $startedAt < $hardTimeLimit
    && ($windows < $minimumWindows || microtime(true) - $startedAt < $normalTimeLimit)
) {
    $windowEnd = min($cursor + 15 * 60, $target);
    $from = gmdate('c', $cursor);
    $to = gmdate('c', $windowEnd);
    $url = $config['osm_api'] . '/changesets?' . http_build_query([
        'bbox' => $config['bbox'],
        'time' => "$from,$to",
        'closed' => 'true',
        'limit' => 100,
    ]);
    $xml = new SimpleXMLElement(file_get_contents($url));

    foreach ($xml->changeset as $changeset) {
        $id = (int) $changeset['id'];
        $diff = new SimpleXMLElement(file_get_contents("{$config['osm_api']}/changeset/$id/download"));
        $createdNodes = [];
        foreach ($diff->xpath('//create/node') as $createdNode) {
            $createdNodes[(string) $createdNode['id']] = true;
        }
        foreach ($diff->xpath('//node') as $node) {
            $tags = [];
            foreach ($node->tag as $tag) {
                $tags[(string) $tag['k']] = (string) $tag['v'];
            }
            // Keep every tagged node. If all tags were removed, also remove a
            // previously stored copy so the database continues to represent
            // the current tagged objects only.
            if (!$tags) {
                $deletePoi->execute([(int) $node['id']]);
                $removed += $deletePoi->rowCount();
                continue;
            }
            if (!isset($node['lat'], $node['lon'])) {
                continue;
            }

            // Prefer keys that describe a POI when several tags exist. This
            // only selects the category shown in the UI; every tag remains in
            // the JSON stored below and no tag key is used as an import filter.
            $category = null;
            foreach ($categoryPriority as $candidate) {
                if (array_key_exists($candidate, $tags)) {
                    $category = $candidate;
                    break;
                }
            }
            $category ??= (string) array_key_first($tags);
            $lat = (float) $node['lat'];
            $lon = (float) $node['lon'];
            if ($lon < $minLon || $lon > $maxLon || $lat < $minLat || $lat > $maxLat) {
                continue;
            }
            if ($isExcludedForeignArea($lat, $lon)) {
                continue;
            }
            $timestamp = (new DateTimeImmutable((string) $node['timestamp']))->format('Y-m-d H:i:s');
            $editorUid = isset($node['uid']) ? (int) $node['uid'] : (isset($changeset['uid']) ? (int) $changeset['uid'] : null);
            $editorName = (string) ($node['user'] ?? $changeset['user'] ?? '');
            $changeAction = isset($createdNodes[(string) $node['id']]) ? 'create' : 'modify';
            $upsert->execute([
                'node', (int) $node['id'], $tags['name'] ?? $tags['name:ja'] ?? null,
                $category, mb_substr($tags[$category], 0, 255), $lat, $lon,
                json_encode($tags, JSON_UNESCAPED_UNICODE), $timestamp, $id,
                $editorUid, $editorName !== '' ? $editorName : null,
                $changeAction,
                $changeAction === 'create' ? $timestamp : null,
                $changeAction === 'create' ? $editorUid : null,
                $changeAction === 'create' && $editorName !== '' ? $editorName : null,
            ]);
            $saved++;
        }
        $changesets++;
        usleep(100000);
    }

    $cursor = $windowEnd;
    $saveCursor->execute([gmdate('c', $cursor)]);
    $windows++;
}

$status = $cursor >= $target ? 'complete' : 'partial';
if ($status === 'complete') {
    $saveCompleted->execute([gmdate('c', $cursor)]);
}
echo "sync $status: windows=$windows changesets=$changesets saved=$saved removed=$removed foreign_removed=$foreignRemoved cursor=" . gmdate('c', $cursor) . "\n";
flock($lockHandle, LOCK_UN);
fclose($lockHandle);
