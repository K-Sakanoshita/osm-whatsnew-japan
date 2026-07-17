<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
$stage = 'initialization';

try {
    $stage = 'database connection';
    $config = require __DIR__ . '/bootstrap.php';
    $db = $config['db'];
    $pdo = new PDO(
        "mysql:host={$db['host']};dbname={$db['dbname']};charset={$db['charset']}",
        $db['user'],
        $db['pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    $allowedDays = [7, 14, 30, 183, 365];
    $days = (int) ($_GET['days'] ?? 14);
    if (!in_array($days, $allowedDays, true)) {
        $days = 14;
    }
    $from = (string) ($_GET['from'] ?? '');
    $to = (string) ($_GET['to'] ?? '');
    $validDate = static fn(string $value): bool => (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)
        && DateTimeImmutable::createFromFormat('!Y-m-d', $value)?->format('Y-m-d') === $value;

    if ($validDate($from) && $validDate($to) && $from <= $to) {
        $periodStart = "$from 00:00:00";
        $periodEnd = "$to 23:59:59";
    } else {
        $stage = 'default period';
        $period = $pdo->query("SELECT UTC_TIMESTAMP() - INTERVAL $days DAY AS period_start, UTC_TIMESTAMP() AS period_end")->fetch(PDO::FETCH_ASSOC);
        $periodStart = (string) $period['period_start'];
        $periodEnd = (string) $period['period_end'];
    }
    $where = 'osm_timestamp >= ' . $pdo->quote($periodStart) . ' AND osm_timestamp <= ' . $pdo->quote($periodEnd);

    $stage = 'total';
    $total = (int) $pdo->query("SELECT COUNT(*) FROM osm_poi WHERE $where")->fetchColumn();
    $stage = 'accounts';
    $accounts = $pdo->query("SELECT editor_uid AS uid,COALESCE(NULLIF(editor_name,''),'不明') AS name,COUNT(*) AS count FROM osm_poi WHERE $where GROUP BY editor_uid,editor_name ORDER BY count DESC,name LIMIT 100")->fetchAll(PDO::FETCH_ASSOC);
    $stage = 'categories';
    $categories = $pdo->query("SELECT category AS type,category_value AS value,COUNT(*) AS count FROM osm_poi WHERE $where GROUP BY category,category_value ORDER BY count DESC,type,value LIMIT 100")->fetchAll(PDO::FETCH_ASSOC);
    // Build the daily ranking in PHP to avoid DB-version-specific aggregate
    // expressions. If an older table has no change_action column, preserve the
    // daily totals and classify those rows as changes.
    $stage = 'daily';
    try {
        $dailySource = $pdo->query("SELECT osm_timestamp,change_action FROM osm_poi WHERE $where")->fetchAll(PDO::FETCH_ASSOC);
    } catch (PDOException $dailyError) {
        error_log('ranking daily action fallback: ' . $dailyError->getMessage());
        $dailySource = $pdo->query("SELECT osm_timestamp FROM osm_poi WHERE $where")->fetchAll(PDO::FETCH_ASSOC);
    }
    $dailyBuckets = [];
    foreach ($dailySource as $dailyRow) {
        $rankingDate = substr((string) $dailyRow['osm_timestamp'], 0, 10);
        if (!isset($dailyBuckets[$rankingDate])) {
            $dailyBuckets[$rankingDate] = ['ranking_date' => $rankingDate, 'creates' => 0, 'modifies' => 0, 'count' => 0];
        }
        $dailyBuckets[$rankingDate]['count']++;
        $dailyBuckets[$rankingDate][($dailyRow['change_action'] ?? '') === 'create' ? 'creates' : 'modifies']++;
    }
    $daily = array_values($dailyBuckets);
    usort($daily, static fn(array $left, array $right): int => $right['count'] <=> $left['count'] ?: strcmp($right['ranking_date'], $left['ranking_date']));
    $daily = array_slice($daily, 0, 100);
    $stage = 'points';
    $points = $pdo->query("SELECT latitude AS lat,longitude AS lon FROM osm_poi WHERE $where")->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        'days' => $days,
        'periodStart' => $periodStart,
        'periodEnd' => $periodEnd,
        'total' => $total,
        'accounts' => $accounts,
        'categories' => $categories,
        'daily' => $daily,
        'points' => $points,
    ], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
} catch (Throwable $e) {
    error_log("whatsnew ranking api [$stage]: " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => "ランキングを取得できません（$stage）。"], JSON_UNESCAPED_UNICODE);
}
