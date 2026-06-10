// server.js — the whole platform.
//
//  Public endpoints (no auth — they must be reachable by stores/devices):
//    GET  /l/:alias                 smart redirect + click logging
//    POST /api/attribute/android    app reports the Play install referrer  (deterministic)
//    POST /api/attribute/ios        app first-launch fingerprint check      (probabilistic)
//
//  Admin endpoints (Bearer ADMIN_TOKEN):
//    GET  /api/links                list links + click/install counts
//    POST /api/links                create a tracked link
//    DELETE /api/links/:alias       remove a link
//    GET  /api/stats/:alias         per-alias breakdown
//
//  Dashboard:  GET /  (static, talks to the admin API)

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, sha, initDb } = require('./db');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';
const BASE_URL = process.env.BASE_URL || '';
const IOS_MATCH_WINDOW_MS = 1000 * 60 * 60 * 24; // 24h

// ---------- helpers ----------
function detectDevice(ua = '') {
  const u = ua.toLowerCase();
  if (/android/.test(u)) return 'android';
  if (/iphone|ipad|ipod|ios/.test(u)) return 'ios';
  if (/windows|macintosh|mac os x|linux|cros/.test(u)) return 'desktop';
  return 'other';
}

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || '';
}

function country(req) {
  return (
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code'] ||
    ''
  ).toUpperCase();
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------- 1. SMART REDIRECT ----------
app.get('/l/:alias', async (req, res) => {
  const result = await db.execute({ sql: 'SELECT * FROM links WHERE alias = ?', args: [req.params.alias] });
  const link = result.rows[0];
  if (!link) return res.status(404).send('Link not found');

  const ua = req.headers['user-agent'] || '';
  const device = detectDevice(ua);
  const ipHash = sha(clientIp(req) + '|' + ua);

  const info = await db.execute({
    sql: 'INSERT INTO clicks (alias, ts, device, country, ip_hash, ua) VALUES (?,?,?,?,?,?)',
    args: [req.params.alias, Date.now(), device, country(req), ipHash, ua.slice(0, 300)]
  });
  const clickId = Number(info.lastInsertRowid);

  if (device === 'android' && link.android_package) {
    const referrer = `alias%3D${encodeURIComponent(link.alias)}%26cid%3D${clickId}`;
    const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(link.android_package)}&referrer=${referrer}`;
    return res.redirect(302, url);
  }

  if (device === 'ios' && link.ios_appstore_id) {
    return res.redirect(302, `https://apps.apple.com/app/id${link.ios_appstore_id}`);
  }

  if (link.desktop_url) return res.redirect(302, link.desktop_url);
  return res.status(200).send('Open this link on your phone to install the app.');
});

// ---------- 2. ANDROID ATTRIBUTION (deterministic) ----------
app.post('/api/attribute/android', async (req, res) => {
  const referrer = req.body.referrer || '';
  const params = new URLSearchParams(referrer);
  const alias = params.get('alias');
  const cid = params.get('cid');
  if (!alias) return res.json({ attributed: false, reason: 'no_alias_in_referrer' });

  const linkResult = await db.execute({ sql: 'SELECT alias FROM links WHERE alias = ?', args: [alias] });
  if (!linkResult.rows[0]) return res.json({ attributed: false, reason: 'unknown_alias' });

  const dedupe = sha('android|' + (cid || alias) + '|' + (req.body.device_id || referrer));
  try {
    await db.execute({
      sql: `INSERT INTO installs (alias, platform, ts, match_type, click_id, dedupe_key)
            VALUES (?, 'android', ?, 'deterministic', ?, ?)`,
      args: [alias, Date.now(), cid ? Number(cid) : null, dedupe]
    });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.json({ attributed: true, duplicate: true });
    throw e;
  }
  const deepLinkResult = await db.execute({ sql: 'SELECT deep_link_path FROM links WHERE alias = ?', args: [alias] });
  res.json({ attributed: true, alias, deep_link_path: deepLinkResult.rows[0]?.deep_link_path || null });
});

// ---------- 3. iOS ATTRIBUTION (probabilistic) ----------
app.post('/api/attribute/ios', async (req, res) => {
  const ua = req.body.ua || req.headers['user-agent'] || '';
  const ipHash = sha(clientIp(req) + '|' + ua);
  const since = Date.now() - IOS_MATCH_WINDOW_MS;

  const candidateResult = await db.execute({
    sql: `SELECT * FROM clicks
          WHERE device = 'ios' AND matched = 0 AND ip_hash = ? AND ts >= ?
          ORDER BY ts DESC LIMIT 1`,
    args: [ipHash, since]
  });
  const candidate = candidateResult.rows[0];
  if (!candidate) return res.json({ attributed: false });

  await db.execute({ sql: 'UPDATE clicks SET matched = 1 WHERE id = ?', args: [candidate.id] });
  const dedupe = sha('ios|' + candidate.id);
  try {
    await db.execute({
      sql: `INSERT INTO installs (alias, platform, ts, match_type, click_id, dedupe_key)
            VALUES (?, 'ios', ?, 'probabilistic', ?, ?)`,
      args: [candidate.alias, Date.now(), candidate.id, dedupe]
    });
  } catch (e) {
    if (!/UNIQUE/.test(e.message)) throw e;
  }
  const linkResult = await db.execute({ sql: 'SELECT deep_link_path FROM links WHERE alias = ?', args: [candidate.alias] });
  res.json({
    attributed: true,
    alias: candidate.alias,
    confidence: 'probabilistic',
    deep_link_path: linkResult.rows[0]?.deep_link_path || null,
  });
});

// ---------- 4. ADMIN: links CRUD ----------
app.get('/api/links', requireAdmin, async (req, res) => {
  const result = await db.execute(`
    SELECT l.*,
      (SELECT COUNT(*) FROM clicks   c WHERE c.alias = l.alias) AS clicks,
      (SELECT COUNT(*) FROM installs i WHERE i.alias = l.alias) AS installs
    FROM links l ORDER BY l.created_at DESC
  `);
  res.json(result.rows);
});

app.post('/api/links', requireAdmin, async (req, res) => {
  let { alias, label, android_package, ios_appstore_id, desktop_url, deep_link_path } = req.body;
  alias = (alias || '').trim() || crypto.randomBytes(4).toString('hex');
  if (!/^[a-zA-Z0-9_-]+$/.test(alias))
    return res.status(400).json({ error: 'alias may only contain letters, numbers, - and _' });

  const existing = await db.execute({ sql: 'SELECT 1 FROM links WHERE alias = ?', args: [alias] });
  if (existing.rows[0])
    return res.status(409).json({ error: 'alias already exists' });

  await db.execute({
    sql: `INSERT INTO links (alias, label, android_package, ios_appstore_id, desktop_url, deep_link_path, created_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [
      alias,
      label || '',
      android_package || '',
      (ios_appstore_id || '').replace(/[^0-9]/g, ''),
      desktop_url || '',
      deep_link_path || '',
      Date.now()
    ]
  });
  res.json({ ok: true, alias });
});

app.delete('/api/links/:alias', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM links WHERE alias = ?', args: [req.params.alias] });
  res.json({ ok: true });
});

// ---------- 5. ADMIN: per-alias stats ----------
app.get('/api/stats/:alias', requireAdmin, async (req, res) => {
  const alias = req.params.alias;
  const [byDevice, byCountry, installs, totalClicksRes, totalInstallsRes] = await Promise.all([
    db.execute({ sql: 'SELECT device, COUNT(*) n FROM clicks WHERE alias = ? GROUP BY device', args: [alias] }),
    db.execute({ sql: "SELECT country, COUNT(*) n FROM clicks WHERE alias = ? AND country <> '' GROUP BY country ORDER BY n DESC LIMIT 10", args: [alias] }),
    db.execute({ sql: 'SELECT platform, match_type, COUNT(*) n FROM installs WHERE alias = ? GROUP BY platform, match_type', args: [alias] }),
    db.execute({ sql: 'SELECT COUNT(*) n FROM clicks WHERE alias = ?', args: [alias] }),
    db.execute({ sql: 'SELECT COUNT(*) n FROM installs WHERE alias = ?', args: [alias] }),
  ]);
  res.json({
    alias,
    totalClicks: Number(totalClicksRes.rows[0]?.n) || 0,
    totalInstalls: Number(totalInstallsRes.rows[0]?.n) || 0,
    byDevice: byDevice.rows,
    byCountry: byCountry.rows,
    installs: installs.rows,
  });
});

app.get('/api/whoami', requireAdmin, (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`trackr running on :${PORT}`);
      if (ADMIN_TOKEN === 'changeme')
        console.log('⚠  Set ADMIN_TOKEN env var before deploying. Currently "changeme".');
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
