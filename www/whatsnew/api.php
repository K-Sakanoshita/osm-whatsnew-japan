<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

$stage = 'initialization';

try {
    $config = require __DIR__ . '/bootstrap.php';
    $db = $config['db'];
    $pdo = new PDO(
        "mysql:host={$db['host']};dbname={$db['dbname']};charset={$db['charset']}",
        $db['user'],
        $db['pass'],
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );

    $mode = strtolower(trim((string) ($_GET['mode'] ?? 'pois')));
    $allowedModes = ['pois', 'japan', 'prefectures', 'facets'];
    if (!in_array($mode, $allowedModes, true)) {
        throw new InvalidArgumentException('mode must be pois, japan, prefectures, or facets.');
    }

    $validDate = static fn(string $value): bool =>
        (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)
        && DateTimeImmutable::createFromFormat('!Y-m-d', $value)?->format('Y-m-d') === $value;

    $allowedDays = [1, 2, 7, 14, 30, 90, 183, 365];
    $days = (int) ($_GET['days'] ?? 14);
    if (!in_array($days, $allowedDays, true)) {
        $days = 14;
    }

    $from = trim((string) ($_GET['from'] ?? ''));
    $to = trim((string) ($_GET['to'] ?? ''));
    if (($from === '') !== ($to === '')) {
        throw new InvalidArgumentException('from and to must be specified together.');
    }

    if ($from !== '') {
        if (!$validDate($from) || !$validDate($to) || $from > $to) {
            throw new InvalidArgumentException('The date range is invalid.');
        }
        // Date inputs represent calendar days in Japan, while osm_timestamp is UTC.
        $japanTimeZone = new DateTimeZone('Asia/Tokyo');
        $utcTimeZone = new DateTimeZone('UTC');
        $periodStartDate = new DateTimeImmutable("{$from} 00:00:00", $japanTimeZone);
        $periodEndExclusiveDate = (new DateTimeImmutable(
            "{$to} 00:00:00",
            $japanTimeZone
        ))->modify('+1 day');
        $periodStart = $periodStartDate->setTimezone($utcTimeZone)->format('Y-m-d H:i:s');
        $periodEndExclusive = $periodEndExclusiveDate
            ->setTimezone($utcTimeZone)
            ->format('Y-m-d H:i:s');
        $periodEnd = $periodEndExclusiveDate
            ->modify('-1 second')
            ->setTimezone($utcTimeZone)
            ->format('Y-m-d H:i:s');
    } else {
        $stage = 'default period';
        $periodStatement = $pdo->query(
            "SELECT UTC_TIMESTAMP() - INTERVAL {$days} DAY AS period_start,
                    UTC_TIMESTAMP() AS period_end"
        );
        $period = $periodStatement->fetch();
        $periodStart = (string) $period['period_start'];
        $periodEnd = (string) $period['period_end'];
        $periodEndExclusive = (new DateTimeImmutable(
            $periodEnd,
            new DateTimeZone('UTC')
        ))->modify('+1 second')->format('Y-m-d H:i:s');
    }

    $conditions = [
        'osm_timestamp >= :period_start',
        'osm_timestamp < :period_end_exclusive',
    ];
    $parameters = [
        'period_start' => $periodStart,
        'period_end_exclusive' => $periodEndExclusive,
    ];
    $filters = [];

    $readTextFilter = static function (string $name, int $maximumLength): string {
        $value = trim((string) ($_GET[$name] ?? ''));
        if (mb_strlen($value) > $maximumLength) {
            throw new InvalidArgumentException("{$name} is too long.");
        }
        return $value;
    };

    $prefecture = $readTextFilter('prefecture', 64);
    if ($prefecture !== '') {
        $conditions[] = 'prefecture = :prefecture';
        $parameters['prefecture'] = $prefecture;
        $filters['prefecture'] = $prefecture;
    }

    $editorUidSource = $_GET['editor_uid'] ?? $_GET['editorUid'] ?? '';
    $editorUidText = trim((string) $editorUidSource);
    if ($editorUidText !== '') {
        if (!preg_match('/^[1-9]\d*$/', $editorUidText)) {
            throw new InvalidArgumentException('editor_uid must be a positive integer.');
        }
        $conditions[] = 'editor_uid = :editor_uid';
        $parameters['editor_uid'] = $editorUidText;
        $filters['editor_uid'] = $editorUidText;
    }

    $editorName = $readTextFilter('editor_name', 255);
    if ($editorName !== '') {
        $conditions[] = 'editor_name = :editor_name';
        $parameters['editor_name'] = $editorName;
        $filters['editor_name'] = $editorName;
    }

    $category = $readTextFilter('category', 255);
    $categoryValue = $readTextFilter('category_value', 255);
    if ($categoryValue !== '' && $category === '') {
        throw new InvalidArgumentException('category_value requires category.');
    }
    if ($category !== '') {
        $conditions[] = 'category = :category';
        $parameters['category'] = $category;
        $filters['category'] = $category;
    }
    if ($categoryValue !== '') {
        $conditions[] = 'category_value = :category_value';
        $parameters['category_value'] = $categoryValue;
        $filters['category_value'] = $categoryValue;
    }

    $action = strtolower($readTextFilter('action', 16));
    if ($action !== '') {
        if (!in_array($action, ['create', 'modify'], true)) {
            throw new InvalidArgumentException('action must be create or modify.');
        }
        $conditions[] = 'change_action = :action';
        $parameters['action'] = $action;
        $filters['action'] = $action;
    }

    $where = implode(' AND ', $conditions);
    $meta = [
        'mode' => $mode,
        'days' => $days,
        'periodStart' => $periodStart,
        'periodEnd' => $periodEnd,
        'filters' => $filters,
    ];

    $fetchAll = static function (
        PDO $pdo,
        string $sql,
        array $parameters
    ): array {
        $statement = $pdo->prepare($sql);
        $statement->execute($parameters);
        return $statement->fetchAll();
    };

    $castCounts = static function (array $rows, array $fields = ['count']): array {
        foreach ($rows as &$row) {
            foreach ($fields as $field) {
                if (array_key_exists($field, $row)) {
                    $row[$field] = (int) $row[$field];
                }
            }
        }
        unset($row);
        return $rows;
    };

    if ($mode === 'pois') {
        $stage = 'pois';
        $limit = max(1, min(5000, (int) ($_GET['limit'] ?? 1000)));
        $cursor = trim((string) ($_GET['cursor'] ?? ''));
        $poiConditions = $conditions;
        $poiParameters = $parameters;

        if ($cursor !== '') {
            $encoded = strtr($cursor, '-_', '+/');
            $padding = strlen($encoded) % 4;
            if ($padding !== 0) {
                $encoded .= str_repeat('=', 4 - $padding);
            }
            $decoded = base64_decode($encoded, true);
            $cursorValues = $decoded === false ? null : json_decode($decoded, true);
            if (!is_array($cursorValues)
                || count($cursorValues) !== 3
                || !is_string($cursorValues[0])
                || !preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $cursorValues[0])
                || !in_array($cursorValues[1], ['node', 'way', 'relation'], true)
                || !is_int($cursorValues[2])) {
                throw new InvalidArgumentException('cursor is invalid.');
            }

            $typeOrder = ['node' => 1, 'way' => 2, 'relation' => 3];
            $poiConditions[] =
                '(osm_timestamp < :cursor_timestamp_before'
                . ' OR (osm_timestamp = :cursor_timestamp_equal'
                . ' AND (FIELD(osm_type,\'node\',\'way\',\'relation\') > :cursor_type_order'
                . ' OR (osm_type = :cursor_type AND osm_id > :cursor_id))))';
            $poiParameters['cursor_timestamp_before'] = $cursorValues[0];
            $poiParameters['cursor_timestamp_equal'] = $cursorValues[0];
            $poiParameters['cursor_type_order'] = $typeOrder[$cursorValues[1]];
            $poiParameters['cursor_type'] = $cursorValues[1];
            $poiParameters['cursor_id'] = $cursorValues[2];
        }

        $poiWhere = implode(' AND ', $poiConditions);
        $queryLimit = $limit + 1;
        $rows = $fetchAll(
            $pdo,
            'SELECT osm_type AS type, osm_id AS id, name,'
            . ' category AS type2, category_value AS kind, tags,'
            . ' latitude AS lat, longitude AS lon, prefecture,'
            . ' osm_timestamp AS date, changeset_id AS changeset,'
            . ' editor_uid AS editorUid, editor_name AS editorName,'
            . ' change_action AS action'
            . " FROM osm_poi WHERE {$poiWhere}"
            . " ORDER BY osm_timestamp DESC, osm_type, osm_id"
            . " LIMIT {$queryLimit}",
            $poiParameters
        );

        $hasMore = count($rows) > $limit;
        if ($hasMore) {
            array_pop($rows);
        }

        $nextCursor = null;
        if ($hasMore && $rows) {
            $last = $rows[array_key_last($rows)];
            $cursorJson = json_encode([
                (string) $last['date'],
                (string) $last['type'],
                (int) $last['id'],
            ], JSON_THROW_ON_ERROR);
            $nextCursor = rtrim(strtr(base64_encode($cursorJson), '+/', '-_'), '=');
        }

        $meta['limit'] = $limit;
        $meta['nextCursor'] = $nextCursor;
        echo json_encode(
            ['meta' => $meta, 'items' => $rows],
            JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
        );
        exit;
    }

    if ($mode === 'prefectures') {
        $stage = 'prefectures';
        $rows = $fetchAll(
            $pdo,
            'SELECT COALESCE(NULLIF(prefecture,\'\'),\'日本国外・判定不能\') AS prefecture,'
            . " COUNT(*) AS count FROM osm_poi WHERE {$where}"
            . ' GROUP BY COALESCE(NULLIF(prefecture,\'\'),\'日本国外・判定不能\')'
            . ' ORDER BY count DESC, prefecture',
            $parameters
        );
        echo json_encode(
            ['meta' => $meta, 'items' => $castCounts($rows)],
            JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
        );
        exit;
    }

    if ($mode === 'facets') {
        $stage = 'facets';
        $mappers = $fetchAll(
            $pdo,
            'SELECT editor_uid AS uid,'
            . " COALESCE(NULLIF(editor_name,''),'不明') AS name,"
            . " SUM(CASE WHEN change_action = 'create' THEN 1 ELSE 0 END) AS creates,"
            . " SUM(CASE WHEN change_action = 'create' THEN 0 ELSE 1 END) AS `modifies`,"
            . " COUNT(*) AS count FROM osm_poi WHERE {$where}"
            . ' GROUP BY editor_uid, editor_name ORDER BY count DESC, name LIMIT 100',
            $parameters
        );
        $categories = $fetchAll(
            $pdo,
            'SELECT category, category_value, COUNT(*) AS count'
            . " FROM osm_poi WHERE {$where}"
            . ' GROUP BY category, category_value'
            . ' ORDER BY count DESC, category, category_value LIMIT 500',
            $parameters
        );
        echo json_encode(
            [
                'meta' => $meta,
                'mappers' => $castCounts($mappers, ['creates', 'modifies', 'count']),
                'categories' => $castCounts($categories),
            ],
            JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
        );
        exit;
    }

    $stage = 'japan total';
    $totalStatement = $pdo->prepare("SELECT COUNT(*) FROM osm_poi WHERE {$where}");
    $totalStatement->execute($parameters);
    $total = (int) $totalStatement->fetchColumn();

    $stage = 'japan changeset count';
    $changesetCountStatement = $pdo->prepare(
        "SELECT COUNT(DISTINCT changeset_id) FROM osm_poi WHERE {$where}"
    );
    $changesetCountStatement->execute($parameters);
    $changesetCount = (int) $changesetCountStatement->fetchColumn();

    $stage = 'japan mapper count';
    $mapperCountStatement = $pdo->prepare(
        "SELECT COUNT(DISTINCT CASE"
        . " WHEN editor_uid IS NOT NULL THEN CONCAT('uid:', editor_uid)"
        . " ELSE CONCAT('name:', COALESCE(NULLIF(editor_name,''),'不明'))"
        . " END) FROM osm_poi WHERE {$where}"
    );
    $mapperCountStatement->execute($parameters);
    $mapperCount = (int) $mapperCountStatement->fetchColumn();

    $stage = 'japan mappers';
    $mappers = $fetchAll(
        $pdo,
        'SELECT editor_uid AS uid,'
        . " COALESCE(NULLIF(editor_name,''),'不明') AS name,"
        . " SUM(CASE WHEN change_action = 'create' THEN 1 ELSE 0 END) AS creates,"
        . " SUM(CASE WHEN change_action = 'create' THEN 0 ELSE 1 END) AS `modifies`,"
        . " COUNT(*) AS count FROM osm_poi WHERE {$where}"
        . ' GROUP BY editor_uid, editor_name ORDER BY count DESC, name LIMIT 100',
        $parameters
    );

    $stage = 'japan changesets';
    $changesets = $fetchAll(
        $pdo,
        'SELECT changeset_id AS changeset,'
        . " MIN(COALESCE(NULLIF(editor_name,''),'不明')) AS editorName,"
        . " SUM(CASE WHEN change_action = 'create' THEN 1 ELSE 0 END) AS creates,"
        . " SUM(CASE WHEN change_action = 'create' THEN 0 ELSE 1 END) AS `modifies`,"
        . ' COUNT(*) AS count'
        . " FROM osm_poi WHERE {$where} AND changeset_id IS NOT NULL"
        . ' GROUP BY changeset_id ORDER BY count DESC, changeset_id DESC LIMIT 100',
        $parameters
    );

    $stage = 'japan categories';
    $categories = $fetchAll(
        $pdo,
        'SELECT category AS type, category_value AS value,'
        . " SUM(CASE WHEN change_action = 'create' THEN 1 ELSE 0 END) AS creates,"
        . " SUM(CASE WHEN change_action = 'create' THEN 0 ELSE 1 END) AS `modifies`,"
        . ' COUNT(*) AS count'
        . " FROM osm_poi WHERE {$where}"
        . ' GROUP BY category, category_value'
        . ' ORDER BY count DESC, type, value LIMIT 100',
        $parameters
    );

    $stage = 'japan daily';
    $daily = $fetchAll(
        $pdo,
        'SELECT DATE(osm_timestamp) AS ranking_date,'
        . " SUM(CASE WHEN change_action = 'create' THEN 1 ELSE 0 END) AS creates,"
        . " SUM(CASE WHEN change_action = 'create' THEN 0 ELSE 1 END) AS `modifies`, "
        . ' COUNT(*) AS count'
        . " FROM osm_poi WHERE {$where}"
        . ' GROUP BY DATE(osm_timestamp)'
        . ' ORDER BY ranking_date',
        $parameters
    );

    $stage = 'japan prefectures';
    $prefectures = $fetchAll(
        $pdo,
        'SELECT COALESCE(NULLIF(prefecture,\'\'),\'日本国外・判定不能\') AS name,'
        . " SUM(CASE WHEN change_action = 'create' THEN 1 ELSE 0 END) AS creates,"
        . " SUM(CASE WHEN change_action = 'create' THEN 0 ELSE 1 END) AS `modifies`,"
        . " COUNT(*) AS count FROM osm_poi WHERE {$where}"
        . ' GROUP BY COALESCE(NULLIF(prefecture,\'\'),\'日本国外・判定不能\')'
        . ' ORDER BY count DESC, name LIMIT 100',
        $parameters
    );

    echo json_encode(
        [
            'meta' => $meta,
            'total' => $total,
            'changesetCount' => $changesetCount,
            'mapperCount' => $mapperCount,
            'mappers' => $castCounts($mappers, ['creates', 'modifies', 'count']),
            'changesets' => $castCounts($changesets, ['creates', 'modifies', 'count']),
            'categories' => $castCounts($categories, ['creates', 'modifies', 'count']),
            'daily' => $castCounts($daily, ['creates', 'modifies', 'count']),
            'prefectures' => $castCounts($prefectures, ['creates', 'modifies', 'count']),
        ],
        JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
    );
} catch (Throwable $e) {
    error_log("whatsnew api [{$stage}]: " . $e->getMessage());
    $isInputError = $e instanceof InvalidArgumentException;
    http_response_code($isInputError ? 400 : 500);

    $message = $isInputError
        ? $e->getMessage()
        : 'サーバー内部エラーが発生しました。';
    if ($e instanceof RuntimeException
        && $e->getMessage() === 'Server configuration is missing.') {
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

    echo json_encode(
        ['error' => $message, 'stage' => $stage],
        JSON_UNESCAPED_UNICODE
    );
}
