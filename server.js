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

// ========== META AD LIBRARY FETCH ==========
app.get('/api/creative/fetch-ads', requireAdmin, async (req, res) => {
  const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  if (!META_ACCESS_TOKEN) return res.status(400).json({ error: 'META_ACCESS_TOKEN not set. Add it to your Render environment variables.' });

  const { competitor, country = 'IN' } = req.query;
  if (!competitor) return res.status(400).json({ error: 'competitor required' });

  const params = new URLSearchParams({
    access_token: META_ACCESS_TOKEN,
    search_terms: competitor,
    ad_type: 'ALL',
    ad_active_status: 'ACTIVE',
    fields: 'id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions,ad_snapshot_url,page_name,impressions,spend,currency',
    limit: '12'
  });
  params.append('ad_reached_countries[]', country);

  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/ads_archive?${params}`);
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ ads: data.data || [], paging: data.paging });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== CREATIVE PIPELINE ==========

// --- Competitors ---
app.get('/api/creative/competitors', requireAdmin, async (req, res) => {
  const r = await db.execute('SELECT * FROM creative_competitors ORDER BY created_at DESC');
  res.json(r.rows);
});
app.post('/api/creative/competitors', requireAdmin, async (req, res) => {
  const { name, ad_lib_url, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  await db.execute({ sql: 'INSERT INTO creative_competitors (name, ad_lib_url, notes, created_at) VALUES (?,?,?,?)', args: [name, ad_lib_url||'', notes||'', Date.now()] });
  res.json({ ok: true });
});
app.delete('/api/creative/competitors/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM creative_competitors WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// --- Research ---
app.get('/api/creative/research', requireAdmin, async (req, res) => {
  const r = await db.execute('SELECT * FROM creative_research ORDER BY created_at DESC');
  res.json(r.rows);
});
app.post('/api/creative/research', requireAdmin, async (req, res) => {
  const { title, content, competitor, hook, format } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title and content required' });
  await db.execute({ sql: 'INSERT INTO creative_research (title, content, competitor, hook, format, created_at) VALUES (?,?,?,?,?,?)', args: [title, content, competitor||'', hook||'', format||'', Date.now()] });
  res.json({ ok: true });
});
app.delete('/api/creative/research/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM creative_research WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// --- Scripts ---
app.get('/api/creative/scripts', requireAdmin, async (req, res) => {
  const r = await db.execute('SELECT * FROM creative_scripts ORDER BY updated_at DESC');
  res.json(r.rows);
});
app.post('/api/creative/scripts', requireAdmin, async (req, res) => {
  const { title, brief, script, status, platform, notes } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const now = Date.now();
  const r = await db.execute({ sql: 'INSERT INTO creative_scripts (title, brief, script, status, platform, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', args: [title, brief||'', script||'', status||'brief', platform||'', notes||'', now, now] });
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
app.put('/api/creative/scripts/:id', requireAdmin, async (req, res) => {
  const { title, brief, script, status, platform, notes } = req.body;
  await db.execute({ sql: 'UPDATE creative_scripts SET title=?, brief=?, script=?, status=?, platform=?, notes=?, updated_at=? WHERE id=?', args: [title, brief||'', script||'', status, platform||'', notes||'', Date.now(), req.params.id] });
  res.json({ ok: true });
});
app.delete('/api/creative/scripts/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM creative_scripts WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// --- AI Script Generation ---
app.post('/api/creative/generate', requireAdmin, async (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in environment variables.' });
  const { brief, research } = req.body;
  if (!brief) return res.status(400).json({ error: 'brief required' });
  const prompt = `You are an expert creative script writer for kids educational apps (like Kiddopia, ABCmouse, Cocomelon). Write a punchy 30-second video ad script for all platforms (Meta, YouTube, TikTok).

Brief: ${brief}
${research ? `Competitor insights: ${research}` : ''}

Format your response exactly like this:
HOOK (0-3s): [opening line that stops the scroll]
SCENE 1 (3-10s): [visual description] | VOICEOVER: [text]
SCENE 2 (10-20s): [visual description] | VOICEOVER: [text]
SCENE 3 (20-27s): [visual description] | VOICEOVER: [text]
CTA (27-30s): [call to action text]
CAPTION: [social media caption with emojis]`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ script: data.content[0].text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
