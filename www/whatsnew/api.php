<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

try {
    $config = require __DIR__ . '/bootstrap.php';
    $db = $config['db'];
    $pdo = new PDO(
        "mysql:host={$db['host']};dbname={$db['dbname']};charset={$db['charset']}",
        $db['user'],
        $db['pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
    $allowedDays = [1, 7, 14, 30, 183, 365];
    $days = (int) ($_GET['days'] ?? 14);
    if (!in_array($days, $allowedDays, true)) {
        $days = 14;
    }
    $limit = max(100, min(2000, (int) ($_GET['limit'] ?? 1000)));
    $page = max(1, (int) ($_GET['page'] ?? 1));
    $offset = ($page - 1) * $limit;
    $from = (string) ($_GET['from'] ?? '');
    $to = (string) ($_GET['to'] ?? '');
    $validDate = static fn(string $value): bool => (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)
        && DateTimeImmutable::createFromFormat('!Y-m-d', $value)?->format('Y-m-d') === $value;

    $select = 'SELECT osm_type AS type,osm_id AS id,name,category AS type2,category_value AS kind,tags,latitude AS lat,longitude AS lon,osm_timestamp AS date,changeset_id AS changeset,editor_uid AS editorUid,editor_name AS editorName FROM osm_poi WHERE ';
    if ($validDate($from) && $validDate($to) && $from <= $to) {
        $sql = $select . 'osm_timestamp >= ? AND osm_timestamp < DATE_ADD(?, INTERVAL 1 DAY) ORDER BY osm_timestamp DESC,osm_type,osm_id LIMIT ' . $limit . ' OFFSET ' . $offset;
        $statement = $pdo->prepare($sql);
        $statement->execute([$from, $to]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
    } else {
        $periodStart = "UTC_DATE() - INTERVAL {$days} DAY";
        $sql = $select . 'osm_timestamp >= ' . $periodStart . ' ORDER BY osm_timestamp DESC,osm_type,osm_id LIMIT ' . $limit . ' OFFSET ' . $offset;
        $rows = $pdo->query($sql)->fetchAll(PDO::FETCH_ASSOC);
    }
    echo json_encode($rows, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
} catch (Throwable $e) {
    error_log('whatsnew api: ' . $e->getMessage());
    http_response_code(500);

    $message = 'サーバー内部エラーが発生しました。';
    if ($e instanceof RuntimeException && $e->getMessage() === 'Server configuration is missing.') {
        $message = 'DB設定ファイルが見つかりません。';
    } elseif ($e instanceof PDOException) {
        $driverCode = isset($e->errorInfo[1]) ? (int) $e->errorInfo[1] : 0;
        if ($e->getCode() === '42S02' || $driverCode === 1146) {
            $message = 'DBテーブルがありません。schema.sqlをDBへ適用してください。';
        } elseif ($driverCode === 1045) {
            $message = 'DB認証に失敗しました。ユーザー名またはDB接続用パスワードを確認してください。';
        } elseif ($driverCode === 1049) {
            $message = '指定したDBが存在しません。DB名を確認してください。';
        } elseif (in_array($driverCode, [2002, 2003, 2005], true)) {
            $message = 'DBサーバーへ到達できません。ホスト名を確認してください。';
        } else {
            $message = 'DBへ接続できません（MySQLエラー ' . $driverCode . '）。';
        }
    }

    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
}
