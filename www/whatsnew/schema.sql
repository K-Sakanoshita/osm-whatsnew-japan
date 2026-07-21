CREATE TABLE IF NOT EXISTS osm_poi (
  osm_type ENUM('node','way','relation') NOT NULL,
  osm_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NULL,
  category VARCHAR(255) NOT NULL,
  category_value VARCHAR(255) NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  prefecture VARCHAR(64) NULL,
  tags JSON NOT NULL,
  osm_timestamp DATETIME NOT NULL,
  changeset_id BIGINT UNSIGNED NOT NULL,
  editor_uid BIGINT UNSIGNED NULL,
  editor_name VARCHAR(255) NULL,
  change_action ENUM('create','modify') NOT NULL DEFAULT 'modify',
  created_osm_at DATETIME NULL,
  creator_uid BIGINT UNSIGNED NULL,
  creator_name VARCHAR(255) NULL,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (osm_type, osm_id),
  KEY osm_timestamp (osm_timestamp),
  KEY category (category),
  KEY prefecture (prefecture),
  KEY prefecture_timestamp (prefecture, osm_timestamp),
  KEY editor_timestamp (editor_uid, osm_timestamp),
  KEY category_value_timestamp (category, category_value, osm_timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- CREATE TABLE IF NOT EXISTS does not update an existing table.
-- Add the prefecture column and index idempotently when importing this file
-- into a database created with an older schema.
SET @prefecture_column_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'osm_poi'
    AND COLUMN_NAME = 'prefecture'
);
SET @prefecture_column_sql = IF(
  @prefecture_column_exists = 0,
  'ALTER TABLE osm_poi ADD COLUMN prefecture VARCHAR(64) NULL AFTER longitude',
  'SELECT 1'
);
PREPARE prefecture_column_statement FROM @prefecture_column_sql;
EXECUTE prefecture_column_statement;
DEALLOCATE PREPARE prefecture_column_statement;

SET @prefecture_index_exists = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'osm_poi'
    AND INDEX_NAME = 'prefecture'
);
SET @prefecture_index_sql = IF(
  @prefecture_index_exists = 0,
  'ALTER TABLE osm_poi ADD INDEX prefecture (prefecture)',
  'SELECT 1'
);
PREPARE prefecture_index_statement FROM @prefecture_index_sql;
EXECUTE prefecture_index_statement;
DEALLOCATE PREPARE prefecture_index_statement;

-- Composite indexes used by api.php filters and date ranges.
SET @api_index_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'osm_poi'
    AND INDEX_NAME = 'prefecture_timestamp'
);
SET @api_index_sql = IF(
  @api_index_exists = 0,
  'ALTER TABLE osm_poi ADD INDEX prefecture_timestamp (prefecture, osm_timestamp)',
  'SELECT 1'
);
PREPARE api_index_statement FROM @api_index_sql;
EXECUTE api_index_statement;
DEALLOCATE PREPARE api_index_statement;

SET @api_index_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'osm_poi'
    AND INDEX_NAME = 'editor_timestamp'
);
SET @api_index_sql = IF(
  @api_index_exists = 0,
  'ALTER TABLE osm_poi ADD INDEX editor_timestamp (editor_uid, osm_timestamp)',
  'SELECT 1'
);
PREPARE api_index_statement FROM @api_index_sql;
EXECUTE api_index_statement;
DEALLOCATE PREPARE api_index_statement;

SET @api_index_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'osm_poi'
    AND INDEX_NAME = 'category_value_timestamp'
);
SET @api_index_sql = IF(
  @api_index_exists = 0,
  'ALTER TABLE osm_poi ADD INDEX category_value_timestamp (category, category_value, osm_timestamp)',
  'SELECT 1'
);
PREPARE api_index_statement FROM @api_index_sql;
EXECUTE api_index_statement;
DEALLOCATE PREPARE api_index_statement;

CREATE TABLE IF NOT EXISTS osm_sync_state (
  state_key VARCHAR(64) PRIMARY KEY,
  state_value VARCHAR(255) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
