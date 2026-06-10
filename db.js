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
  `);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = { db, sha, initDb };
