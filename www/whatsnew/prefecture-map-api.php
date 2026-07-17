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
    $statement = $pdo->prepare('SELECT latitude AS lat,longitude AS lon FROM osm_poi WHERE osm_timestamp >= ? AND osm_timestamp < DATE_ADD(?,INTERVAL 1 DAY)');
    $statement->execute([$from, $to]);
    echo json_encode(['points' => $statement->fetchAll(PDO::FETCH_ASSOC)], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    error_log('prefecture map api: ' . $error->getMessage());
    http_response_code(500);
    echo json_encode(['error' => $error instanceof InvalidArgumentException ? $error->getMessage() : '全国集計を取得できません。'], JSON_UNESCAPED_UNICODE);
}
