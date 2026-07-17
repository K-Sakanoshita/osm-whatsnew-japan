<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

try {
    $config = require __DIR__ . '/bootstrap.php';
    $db = $config['db'];
    $pdo = new PDO(
        "mysql:host={$db['host']};dbname={$db['dbname']};charset={$db['charset']}",
        $db['user'], $db['pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    $from = (string) ($_GET['from'] ?? '');
    $to = (string) ($_GET['to'] ?? '');
    $validDate = static fn(string $value): bool => (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)
        && DateTimeImmutable::createFromFormat('!Y-m-d', $value)?->format('Y-m-d') === $value;
    if (!$validDate($from) || !$validDate($to) || $from > $to) {
        throw new InvalidArgumentException('集計期間が正しくありません。');
    }

    $bounds = [];
    foreach (['minLon', 'minLat', 'maxLon', 'maxLat'] as $key) {
        if (!isset($_GET[$key]) || !is_numeric($_GET[$key])) throw new InvalidArgumentException('都道府県の範囲が正しくありません。');
        $bounds[$key] = (float) $_GET[$key];
    }
    if ($bounds['minLon'] >= $bounds['maxLon'] || $bounds['minLat'] >= $bounds['maxLat']) {
        throw new InvalidArgumentException('都道府県の範囲が正しくありません。');
    }

    $sql = 'SELECT osm_type AS osmType,osm_id AS id,name,category AS type,category_value AS value,latitude AS lat,longitude AS lon,osm_timestamp AS date,changeset_id AS changeset,editor_uid AS editorUid,editor_name AS editorName,change_action AS action FROM osm_poi WHERE osm_timestamp >= ? AND osm_timestamp < DATE_ADD(?,INTERVAL 1 DAY) AND longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ? ORDER BY osm_timestamp DESC';
    $statement = $pdo->prepare($sql);
    $statement->execute([$from, $to, $bounds['minLon'], $bounds['maxLon'], $bounds['minLat'], $bounds['maxLat']]);
    echo json_encode(['periodStart' => "$from 00:00:00", 'periodEnd' => "$to 23:59:59", 'rows' => $statement->fetchAll(PDO::FETCH_ASSOC)], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    error_log('prefectures api: ' . $error->getMessage());
    http_response_code(500);
    echo json_encode(['error' => $error instanceof InvalidArgumentException ? $error->getMessage() : '都道府県別集計を取得できません。'], JSON_UNESCAPED_UNICODE);
}
