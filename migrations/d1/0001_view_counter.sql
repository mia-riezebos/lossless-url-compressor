CREATE TABLE IF NOT EXISTS view_counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS view_counter_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_view_counter_snapshots_key_created_at
  ON view_counter_snapshots (key, created_at);
