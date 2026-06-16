// db.js — storage via Turso (libSQL). Persists across Render restarts with no disk needed.
const { createClient } = require('@libsql/client');
const crypto = require('crypto');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS links (
      alias            TEXT PRIMARY KEY,
      label            TEXT,
      android_package  TEXT,
      ios_appstore_id  TEXT,
      desktop_url      TEXT,
      deep_link_path   TEXT,
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clicks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      alias       TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      device      TEXT,
      country     TEXT,
      ip_hash     TEXT,
      ua          TEXT,
      matched     INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_clicks_alias ON clicks(alias);
    CREATE INDEX IF NOT EXISTS idx_clicks_match ON clicks(device, matched, ts);

    CREATE TABLE IF NOT EXISTS installs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      alias       TEXT NOT NULL,
      platform    TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      match_type  TEXT NOT NULL,
      click_id    INTEGER,
      dedupe_key  TEXT UNIQUE
    );

    CREATE INDEX IF NOT EXISTS idx_installs_alias ON installs(alias);

    CREATE TABLE IF NOT EXISTS creative_competitors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      ad_lib_url  TEXT,
      notes       TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creative_research (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      content      TEXT NOT NULL,
      competitor   TEXT,
      hook         TEXT,
      format       TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS social_posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT NOT NULL,
      platform    TEXT NOT NULL DEFAULT 'youtube',
      post_id     TEXT NOT NULL,
      channel_name TEXT DEFAULT '',
      game        TEXT DEFAULT 'tmkoc',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS social_post_snapshots (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id   INTEGER NOT NULL,
      ts        INTEGER NOT NULL,
      views     INTEGER DEFAULT 0,
      likes     INTEGER DEFAULT 0,
      comments  INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_post_snaps ON social_post_snapshots(post_id, ts);

    CREATE TABLE IF NOT EXISTS social_channels (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      platform    TEXT NOT NULL,
      channel_id  TEXT DEFAULT '',
      game        TEXT DEFAULT 'tmkoc',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS social_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id  INTEGER NOT NULL,
      ts          INTEGER NOT NULL,
      followers   INTEGER DEFAULT 0,
      views       INTEGER DEFAULT 0,
      posts       INTEGER DEFAULT 0,
      extra       TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_channel ON social_snapshots(channel_id, ts);

    CREATE TABLE IF NOT EXISTS creative_scripts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      brief       TEXT,
      script      TEXT,
      status      TEXT NOT NULL DEFAULT 'brief',
      platform    TEXT,
      notes       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);

  // Migrations — safe to run every boot
  const newCols = [
    ['creative_research',    'headline', 'TEXT DEFAULT ""'],
    ['creative_research',    'caption',  'TEXT DEFAULT ""'],
    ['creative_research',    'cta',      'TEXT DEFAULT ""'],
    ['creative_research',    'platform', 'TEXT DEFAULT ""'],
    ['creative_research',    'game',     'TEXT DEFAULT "tmkoc"'],
    ['creative_competitors', 'game',     'TEXT DEFAULT "tmkoc"'],
    ['creative_scripts',     'game',     'TEXT DEFAULT "tmkoc"'],
    ['links',                'game',     'TEXT DEFAULT "tmkoc"'],
  ];
  for (const [table, col, def] of newCols) {
    try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch(e) {}
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = { db, sha, initDb };
