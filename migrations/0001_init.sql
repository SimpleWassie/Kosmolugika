PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS galaxies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, galaxy_id TEXT NOT NULL REFERENCES galaxies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, galaxy_id TEXT NOT NULL REFERENCES galaxies(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('scene','character','location','prop','lore','note')),
  category_id TEXT, title TEXT NOT NULL, summary TEXT DEFAULT '', body TEXT DEFAULT '',
  act INTEGER, episode INTEGER, sequence INTEGER, tasks TEXT DEFAULT '[]', refs TEXT DEFAULT '[]',
  x REAL DEFAULT 0, y REAL DEFAULT 0, z REAL DEFAULT 0,
  deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, galaxy_id TEXT NOT NULL REFERENCES galaxies(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, label TEXT, directed INTEGER DEFAULT 0,
  CHECK(from_id <> to_id), UNIQUE(galaxy_id, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_items_galaxy ON items(galaxy_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_links_galaxy ON links(galaxy_id);

