-- Stratum D1 Schema
-- Mirrors the Navidrome/Subsonic data model

CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  biography TEXT,
  image_url TEXT,
  mbz_artist_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  artist_name TEXT NOT NULL,
  year INTEGER,
  genre TEXT,
  cover_art_id TEXT,
  song_count INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  play_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sort_title TEXT,
  album_id TEXT NOT NULL REFERENCES albums(id),
  album_name TEXT NOT NULL,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  artist_name TEXT NOT NULL,
  track_number INTEGER,
  disc_number INTEGER DEFAULT 1,
  year INTEGER,
  genre TEXT,
  duration INTEGER DEFAULT 0,
  bit_rate INTEGER,
  size INTEGER,
  suffix TEXT,
  content_type TEXT,
  path TEXT,
  cover_art_id TEXT,
  play_count INTEGER DEFAULT 0,
  starred_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  comment TEXT,
  owner TEXT NOT NULL DEFAULT 'admin',
  public INTEGER DEFAULT 0,
  song_count INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS play_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  played_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS starred (
  user TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL, -- 'track', 'album', 'artist'
  starred_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user, item_id, item_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_play_history_user ON play_history(user, played_at);
CREATE INDEX IF NOT EXISTS idx_starred_user ON starred(user);
