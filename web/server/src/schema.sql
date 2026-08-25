-- SQLite schema for the local history server. schema_version = 1

PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id        TEXT PRIMARY KEY,
  serial_number    TEXT UNIQUE,
  name             TEXT,
  model            TEXT,
  device_type      TEXT NOT NULL DEFAULT 'unknown',
  capacity_ml      INTEGER,
  colour           TEXT,
  fw_version       TEXT,
  fw_hardware      TEXT,
  fw_bootloader    TEXT,
  liquid_level_max INTEGER NOT NULL DEFAULT 30,
  first_seen_ms    INTEGER NOT NULL,
  last_seen_ms     INTEGER NOT NULL,
  ble_hint         TEXT,
  meta_json        TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  started_ms   INTEGER NOT NULL,
  ended_ms     INTEGER,
  end_reason   TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0,
  app_version  TEXT
);

CREATE INDEX IF NOT EXISTS ix_sessions_dev_start ON sessions(device_id, started_ms);

-- Integers in device-native resolution. `target_c` is NULL, never 0, when temperature
-- control is off, so a bucket average is not dragged to the floor by a sentinel.
--
-- WITHOUT ROWID: narrow rows behind a composite primary key, which roughly halves the
-- file size against a rowid table carrying a redundant (device_id, ts) index. Do not copy
-- this pattern if wide TEXT columns are ever added here.
CREATE TABLE IF NOT EXISTS samples (
  device_id    TEXT    NOT NULL,
  ts           INTEGER NOT NULL,
  session_id   TEXT,
  temp_c       INTEGER,
  target_c     INTEGER,
  battery_dpc  INTEGER,
  liquid_dpc   INTEGER,
  liquid_state INTEGER,
  battery_mv   INTEGER,
  flags        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS events (
  event_id   TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  session_id TEXT,
  num_a      REAL,
  num_b      REAL,
  text_a     TEXT,
  data_json  TEXT
);

-- Natural key: kills duplicates arriving from a second browser, and doubles as the
-- (device_id, ts) range index by prefix, so no second index is needed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_natural ON events(device_id, ts, type);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
