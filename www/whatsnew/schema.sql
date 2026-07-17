CREATE TABLE IF NOT EXISTS osm_poi (
  osm_type ENUM('node','way','relation') NOT NULL,
  osm_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NULL,
  category VARCHAR(255) NOT NULL,
  category_value VARCHAR(255) NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
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
  KEY category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS osm_sync_state (
  state_key VARCHAR(64) PRIMARY KEY,
  state_value VARCHAR(255) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
