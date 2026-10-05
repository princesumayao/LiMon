CREATE DATABASE IF NOT EXISTS limon;
USE limon;

CREATE TABLE IF NOT EXISTS environment_readings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  area VARCHAR(50) NOT NULL,
  temperature DECIMAL(5,2) NOT NULL,
  humidity DECIMAL(5,2) NOT NULL,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS noise_readings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  area VARCHAR(50) NOT NULL,
  noise_db INT NOT NULL,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS occupancy_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  area VARCHAR(50) NOT NULL,
  epc VARCHAR(64) NOT NULL,
  direction ENUM('IN', 'OUT') NOT NULL,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  area VARCHAR(50) NOT NULL,
  type VARCHAR(20) NOT NULL,        -- TEMP, NOISE, OCC, HUMID
  message VARCHAR(255) NOT NULL,
  severity VARCHAR(20) NOT NULL,    -- normal, moderate, above_limit
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per area per day. Computed once nightly by rollupJob.js so that
-- historical reports (e.g. "last 5 months") read a handful of small rows
-- instead of scanning millions of raw per-second readings.
CREATE TABLE IF NOT EXISTS daily_summary (
  id INT AUTO_INCREMENT PRIMARY KEY,
  summary_date DATE NOT NULL,
  area VARCHAR(50) NOT NULL,
  avg_noise_db DECIMAL(5,2),
  min_noise_db INT,
  max_noise_db INT,
  noise_reading_count INT DEFAULT 0,
  avg_temperature DECIMAL(5,2),
  min_temperature DECIMAL(5,2),
  max_temperature DECIMAL(5,2),
  avg_humidity DECIMAL(5,2),
  min_humidity DECIMAL(5,2),
  max_humidity DECIMAL(5,2),
  env_reading_count INT DEFAULT 0,
  entered INT DEFAULT 0,
  exited INT DEFAULT 0,
  alerts_moderate INT DEFAULT 0,
  alerts_above_limit INT DEFAULT 0,
  UNIQUE KEY unique_day_area (summary_date, area)
);

-- Per-table occupancy status, fed either by our own simulator (for now) or
-- by the CS department's camera system later (same schema either way, so
-- swapping the data source requires no changes here or on the frontend).
CREATE TABLE IF NOT EXISTS table_status (
  id INT AUTO_INCREMENT PRIMARY KEY,
  area VARCHAR(50) NOT NULL,
  table_label VARCHAR(50) NOT NULL,
  total_seats INT NOT NULL DEFAULT 4,
  occupied_seats INT NOT NULL DEFAULT 0,
  source ENUM('simulated','camera') NOT NULL DEFAULT 'simulated',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_area_table (area, table_label)
);

-- Speeds up both the rollup job and any date-range queries against the
-- raw tables, since "WHERE DATE(recorded_at) = ..." across months of data
-- would otherwise scan every row.
-- MySQL has no "CREATE INDEX IF NOT EXISTS", unlike CREATE TABLE - so a
-- second run of this file (e.g. after adding a new table below) would
-- hard-error on an index that's already there and stop partway through,
-- silently skipping everything after it. This throwaway procedure checks
-- information_schema first and only creates an index that's missing, so
-- the whole file stays safe to run again at any time.
DELIMITER $$
CREATE PROCEDURE limon_create_index_if_missing(
  IN idx_table VARCHAR(64), IN idx_name VARCHAR(64), IN idx_cols VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = idx_table AND index_name = idx_name
  ) THEN
    SET @sql = CONCAT('CREATE INDEX ', idx_name, ' ON ', idx_table, ' (', idx_cols, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL limon_create_index_if_missing('noise_readings', 'idx_noise_recorded_at', 'recorded_at');
CALL limon_create_index_if_missing('environment_readings', 'idx_env_recorded_at', 'recorded_at');
CALL limon_create_index_if_missing('occupancy_events', 'idx_occupancy_recorded_at', 'recorded_at');
CALL limon_create_index_if_missing('notifications', 'idx_notifications_recorded_at', 'recorded_at');

DROP PROCEDURE limon_create_index_if_missing;

-- ---- Migration: table_status moved from a binary available/occupied
-- status to a seat-count model (total_seats / occupied_seats), so the
-- table map can show how many of a table's seats are taken instead of
-- just "occupied or not". If you already ran the old schema and have an
-- existing table_status table, run this once instead of dropping data:
--
--   ALTER TABLE table_status
--     ADD COLUMN total_seats INT NOT NULL DEFAULT 4 AFTER table_label,
--     ADD COLUMN occupied_seats INT NOT NULL DEFAULT 0 AFTER total_seats;
--   UPDATE table_status SET occupied_seats = IF(status = 'occupied', total_seats, 0);
--   ALTER TABLE table_status DROP COLUMN status;
--
-- (New/fresh databases don't need this - the CREATE TABLE above already
-- has the right columns.)

-- ---- Settings (generic key/value store) ----
-- Used for runtime-configurable options, starting with how often sensor
-- readings get persisted to noise_readings/environment_readings. Kept
-- as key/value rather than dedicated columns so future settings don't
-- need a schema change.
CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Default: 0 = save every reading (today's behavior, unchanged unless
-- someone raises the interval from the dashboard).
INSERT INTO settings (setting_key, setting_value)
VALUES ('sensor_log_interval_ms', '0')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- Migration for an existing database that already ran the schema above
-- without the settings table:
--
--   CREATE TABLE IF NOT EXISTS settings (
--     setting_key VARCHAR(100) PRIMARY KEY,
--     setting_value VARCHAR(255) NOT NULL,
--     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
--   );
--   INSERT INTO settings (setting_key, setting_value)
--   VALUES ('sensor_log_interval_ms', '0')
--   ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- Per-tag debounce/direction state for rfidBridge.js. Persisted here
-- instead of only in memory so a restart of the bridge script (crash,
-- Windows update, manual stop) doesn't forget mid-crossing tags and
-- reset everyone's next read back to IN. Written to once per confirmed
-- crossing (same rate as the MQTT publish), never on every raw read -
-- so this does not add meaningful load even during continuous polling.
CREATE TABLE IF NOT EXISTS rfid_tag_state (
  epc VARCHAR(64) PRIMARY KEY,
  last_seen DATETIME NOT NULL,
  last_direction ENUM('IN', 'OUT') NOT NULL
);

-- ---- Users (staff accounts + role-based access) ----
-- password_hash is never a plain password - see backend/auth.js, which
-- hashes with Node's built-in crypto module (scrypt) before this table
-- ever sees it. role is what gates access to admin-only features like
-- the sensor log frequency setting. full_name is what's actually shown
-- in the dashboard sidebar, rather than the raw staff ID.
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  staff_id VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  role ENUM('admin','staff') NOT NULL DEFAULT 'staff',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Migration for an existing database:
--
--   CREATE TABLE IF NOT EXISTS users (
--     id INT AUTO_INCREMENT PRIMARY KEY,
--     staff_id VARCHAR(50) NOT NULL UNIQUE,
--     password_hash VARCHAR(255) NOT NULL,
--     full_name VARCHAR(100) NOT NULL,
--     role ENUM('admin','staff') NOT NULL DEFAULT 'staff',
--     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
--   );
--
-- Then create accounts by running:  node seedUsers.js
-- (it hashes the passwords for you - never insert plain-text passwords
-- directly into this table)


-- all noise readings today
-- SELECT * FROM noise_readings
-- WHERE DATE(recorded_at) = CURDATE()
-- ORDER BY recorded_at;

-- -- one test window only, for one area
-- SELECT recorded_at, temperature, humidity
-- FROM environment_readings
-- WHERE area = 'Area A'
--   AND recorded_at BETWEEN '2026-10-06 09:00:00' AND '2026-10-06 11:00:00'
-- ORDER BY recorded_at;

-- -- the system value nearest to a time you wrote on the sheet
-- SELECT recorded_at, temperature, humidity
-- FROM environment_readings
-- WHERE area = 'Area A'
-- ORDER BY ABS(TIMESTAMPDIFF(SECOND, recorded_at, '2026-10-06 09:25:30'))
-- LIMIT 1;