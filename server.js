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
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { db, sha, initDb } = require('./db');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 150 * 1024 * 1024 } });

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';
const BASE_URL = process.env.BASE_URL || '';
const IOS_MATCH_WINDOW_MS = 1000 * 60 * 60 * 24; // 24h

// ---------- game context ----------
function gameCtx(game) {
  if (game === 'gada') return {
    appName: 'Gada Electronics',
    genre: 'casual mobile shop management game',
    audience: 'casual mobile gamers aged 18–35',
    competitors: 'Pizza Ready, Burger Please, Outlets Rush',
    adStyle: 'fun, fast-paced, colourful gameplay showcase, addictive loop',
  };
  return {
    appName: 'TMKOC Playschool',
    genre: 'kids educational app',
    audience: 'parents of children aged 2–8',
    competitors: 'Kiddopia, ABCmouse, Cocomelon, Khan Academy Kids',
    adStyle: 'warm, cheerful, educational, trust-building, parent-focused',
  };
}

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
  const game = req.query.game || 'tmkoc';
  const result = await db.execute({
    sql: `SELECT l.*,
      (SELECT COUNT(*) FROM clicks   c WHERE c.alias = l.alias) AS clicks,
      (SELECT COUNT(*) FROM installs i WHERE i.alias = l.alias) AS installs
    FROM links l WHERE l.game = ? ORDER BY l.created_at DESC`,
    args: [game]
  });
  res.json(result.rows);
});

app.post('/api/links', requireAdmin, async (req, res) => {
  let { alias, label, android_package, ios_appstore_id, desktop_url, deep_link_path, game = 'tmkoc' } = req.body;
  alias = (alias || '').trim() || crypto.randomBytes(4).toString('hex');
  if (!/^[a-zA-Z0-9_-]+$/.test(alias))
    return res.status(400).json({ error: 'alias may only contain letters, numbers, - and _' });

  const existing = await db.execute({ sql: 'SELECT 1 FROM links WHERE alias = ?', args: [alias] });
  if (existing.rows[0])
    return res.status(409).json({ error: 'alias already exists' });

  await db.execute({
    sql: `INSERT INTO links (alias, label, android_package, ios_appstore_id, desktop_url, deep_link_path, game, created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [
      alias,
      label || '',
      android_package || '',
      (ios_appstore_id || '').replace(/[^0-9]/g, ''),
      desktop_url || '',
      deep_link_path || '',
      game,
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
  const game = req.query.game || 'tmkoc';
  const r = await db.execute({ sql: 'SELECT * FROM creative_competitors WHERE game = ? ORDER BY created_at DESC', args: [game] });
  res.json(r.rows);
});
app.post('/api/creative/competitors', requireAdmin, async (req, res) => {
  const { name, ad_lib_url, notes, game = 'tmkoc' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  await db.execute({ sql: 'INSERT INTO creative_competitors (name, ad_lib_url, notes, game, created_at) VALUES (?,?,?,?,?)', args: [name, ad_lib_url||'', notes||'', game, Date.now()] });
  res.json({ ok: true });
});
app.delete('/api/creative/competitors/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM creative_competitors WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// --- Research ---
app.get('/api/creative/research', requireAdmin, async (req, res) => {
  const game = req.query.game || 'tmkoc';
  const r = await db.execute({ sql: 'SELECT * FROM creative_research WHERE game = ? ORDER BY created_at DESC', args: [game] });
  res.json(r.rows);
});
app.post('/api/creative/research', requireAdmin, async (req, res) => {
  const { title, content, competitor, hook, format, headline, caption, cta, platform, game = 'tmkoc' } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  await db.execute({ sql: 'INSERT INTO creative_research (title, content, competitor, hook, format, headline, caption, cta, platform, game, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: [title, content||'', competitor||'', hook||'', format||'', headline||'', caption||'', cta||'', platform||'', game, Date.now()] });
  res.json({ ok: true });
});
app.delete('/api/creative/research/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM creative_research WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// --- Scripts ---
app.get('/api/creative/scripts', requireAdmin, async (req, res) => {
  const game = req.query.game || 'tmkoc';
  const r = await db.execute({ sql: 'SELECT * FROM creative_scripts WHERE game = ? ORDER BY updated_at DESC', args: [game] });
  res.json(r.rows);
});
app.post('/api/creative/scripts', requireAdmin, async (req, res) => {
  const { title, brief, script, status, platform, notes, game = 'tmkoc' } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const now = Date.now();
  const r = await db.execute({ sql: 'INSERT INTO creative_scripts (title, brief, script, status, platform, notes, game, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)', args: [title, brief||'', script||'', status||'brief', platform||'', notes||'', game, now, now] });
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
  const { brief, research, game = 'tmkoc' } = req.body;
  if (!brief) return res.status(400).json({ error: 'brief required' });
  const ctx = gameCtx(game);
  const prompt = `You are an expert creative script writer for ${ctx.appName}, a ${ctx.genre}. Write a punchy 30-second video ad script targeting ${ctx.audience} for all platforms (Meta, YouTube, TikTok). Style: ${ctx.adStyle}.

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

// --- Caption Suggestions ---
app.post('/api/creative/captions', requireAdmin, async (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set.' });

  const { brief, platform, tone, game = 'tmkoc' } = req.body;
  if (!brief) return res.status(400).json({ error: 'brief required' });
  const ctx = gameCtx(game);

  // Pull research for context
  const researchResult = await db.execute({ sql: 'SELECT * FROM creative_research WHERE game = ? ORDER BY created_at DESC LIMIT 8', args: [game] });
  const researchContext = researchResult.rows.map(r => [
    r.title,
    r.caption  ? `Caption: ${r.caption}` : '',
    r.hook     ? `Hook: ${r.hook}` : '',
    r.cta      ? `CTA: ${r.cta}` : '',
  ].filter(Boolean).join(' | ')).join('\n');

  const prompt = `You are an expert social media copywriter for ${ctx.appName}, a ${ctx.genre}. Target audience: ${ctx.audience}. Competitors: ${ctx.competitors}. Ad style: ${ctx.adStyle}.

Brief: ${brief}
Platform: ${platform || 'All platforms'}
Tone: ${tone || 'Warm and engaging'}
${researchContext ? `\nCompetitor caption insights:\n${researchContext}` : ''}

Generate 6 caption variations, each with a different angle. Return ONLY a valid JSON array — no markdown, no explanation.

[
  {
    "angle": "Hook",
    "caption": "...",
    "note": "one sentence on why this angle works"
  }
]

Angles in order: Hook, Problem-aware, Social Proof, Emotional, Trendy/UGC, CTA-heavy

Rules:
- Each caption must be ready to paste — no placeholders
- Include relevant emojis
- End each with a CTA line
- Keep under 150 words each
- Match the platform style (TikTok = casual, Meta = slightly more formal, etc.)`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    let captions;
    try {
      const text = data.content[0].text.trim();
      const match = text.match(/\[[\s\S]*\]/);
      captions = JSON.parse(match ? match[0] : text);
    } catch(e) {
      return res.status(500).json({ error: 'Could not parse captions. Try again.' });
    }
    res.json({ captions });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Storyboard Generation ---
app.post('/api/creative/storyboard', requireAdmin, async (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set.' });

  const { brief, game = 'tmkoc' } = req.body;
  if (!brief) return res.status(400).json({ error: 'brief required' });
  const ctx = gameCtx(game);

  // Pull recent research for trend context
  const researchResult = await db.execute({ sql: 'SELECT * FROM creative_research WHERE game = ? ORDER BY created_at DESC LIMIT 10', args: [game] });
  const researchContext = researchResult.rows.map(r => [
    r.title,
    r.hook     ? `Hook: ${r.hook}` : '',
    r.headline ? `Headline: ${r.headline}` : '',
    r.content  ? `Insight: ${r.content}` : '',
  ].filter(Boolean).join(' | ')).join('\n');

  try {
    // Step 1: Claude generates 6 scene descriptions + image prompts
    const claudePrompt = `You are a storyboard director specialising in video ads for ${ctx.appName}, a ${ctx.genre}. Target audience: ${ctx.audience}. Competitors: ${ctx.competitors}. Visual style: ${ctx.adStyle}.

Brief: ${brief}
${researchContext ? `\nCompetitor research & trends:\n${researchContext}` : ''}

Generate a 6-panel storyboard for a 30-second animated video ad that reflects the trends above.
Return ONLY a valid JSON array — no markdown, no explanation.

[
  {
    "scene": 1,
    "timing": "0-3s",
    "label": "Hook",
    "voiceover": "...",
    "scene_description": "What the animator sees — characters, action, setting, mood",
    "image_prompt": "${ctx.genre === 'kids educational app' ? 'Bright colorful 2D kids animation, Cocomelon art style, cheerful warm palette' : 'Colorful casual mobile game UI art style, vibrant, cartoon shop setting'}, [specific scene details], storyboard frame, NO text or letters visible in image"
  }
]

Labels in order: Hook, Problem, Solution, Feature Demo, Social Proof, CTA
Make image_prompts highly visual and scene-specific. Always end with: cheerful warm palette, Cocomelon art style, storyboard frame, NO text in image.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2500, messages: [{ role: 'user', content: claudePrompt }] })
    });
    const claudeData = await claudeRes.json();
    if (claudeData.error) return res.status(500).json({ error: 'Claude: ' + claudeData.error.message });

    let scenes;
    try {
      const text = claudeData.content[0].text.trim();
      const match = text.match(/\[[\s\S]*\]/);
      scenes = JSON.parse(match ? match[0] : text);
    } catch(e) {
      return res.status(500).json({ error: 'Could not parse scene list. Try again.' });
    }

    // Step 2: Generate images with Pollinations.ai (free, no API key needed)
    const imagePromises = scenes.map(async (scene) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        const encoded = encodeURIComponent(scene.image_prompt);
        const image_url = `https://image.pollinations.ai/prompt/${encoded}?width=896&height=504&model=flux&nologo=true&seed=${scene.scene}`;
        // Verify the image is reachable
        const r = await fetch(image_url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timer);
        return { ...scene, image_url: r.ok ? image_url : null, image_error: r.ok ? null : `HTTP ${r.status}` };
      } catch(e) {
        clearTimeout(timer);
        return { ...scene, image_url: null, image_error: e.name === 'AbortError' ? 'timeout' : e.message };
      }
    });

    const panels = await Promise.all(imagePromises);
    res.json({ panels });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Video Analysis ---
app.post('/api/creative/analyze-video', requireAdmin, upload.single('video'), async (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in environment variables.' });

  const url = (req.body?.url || '').trim();
  const file = req.file;

  if (!url && !file) return res.status(400).json({ error: 'Provide a YouTube URL or upload an MP4 file.' });

  try {
    const msgContent = [];
    let contextNote = '';

    if (file) {
      const frames = await extractVideoFrames(file.path);
      for (const fp of frames) {
        try {
          const data = fs.readFileSync(fp);
          msgContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } });
          fs.unlinkSync(fp);
        } catch(e) {}
      }
      try { fs.unlinkSync(file.path); } catch(e) {}
      contextNote = `Uploaded video: ${file.originalname || 'video.mp4'} — ${frames.length} frames extracted`;
    } else {
      const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (ytMatch) {
        const vid = ytMatch[1];
        try {
          const oe = await fetch(`https://www.youtube.com/oembed?url=https://youtube.com/watch?v=${vid}&format=json`);
          if (oe.ok) { const d = await oe.json(); contextNote = `YouTube: "${d.title}" by ${d.author_name}`; }
        } catch(e) {}
        for (const thumbUrl of [`https://img.youtube.com/vi/${vid}/maxresdefault.jpg`, `https://img.youtube.com/vi/${vid}/hqdefault.jpg`]) {
          try {
            const r = await fetch(thumbUrl);
            if (r.ok) {
              const buf = Buffer.from(await r.arrayBuffer());
              msgContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
              break;
            }
          } catch(e) {}
        }
        if (!contextNote) contextNote = `YouTube URL: ${url}`;
      } else {
        contextNote = `Video URL: ${url}`;
      }
    }

    msgContent.push({ type: 'text', text: `You are an expert creative strategist for kids educational apps (Kiddopia, ABCmouse, Khan Academy Kids, Cocomelon).

${contextNote ? `Context: ${contextNote}` : ''}

Analyze this ad creative and give a detailed breakdown. Format your response exactly like this:

🎯 HOOK (0–3s)
[What grabs attention immediately — question, shock, emotion, visual]

😰 PROBLEM SETUP
[What parent/child pain point is addressed and how relatable it is]

✨ SOLUTION REVEAL
[How the product is presented and what features are highlighted]

💡 WHY IT WORKS
[Core psychological reason — FOMO, social proof, urgency, aspiration]

🎨 VISUAL STRATEGY
[Colors, characters, pacing, animation style, text overlays]

📣 CTA STRENGTH
[How effective is the call to action — rate and explain]

🔁 WHAT TO REPLICATE
[3 specific elements to copy for your own kids app creatives]

✍️ BRIEF FOR A SIMILAR CREATIVE
[A 2-sentence brief you could hand to a creator right now]

Be specific, actionable, and focused on what converts for parents of children aged 2–8.` });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: msgContent }] })
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ analysis: data.content[0].text, context: contextNote });
  } catch(e) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(ee) {}
    res.status(500).json({ error: e.message });
  }
});

function extractVideoFrames(videoPath) {
  return new Promise(resolve => {
    const ts = Date.now();
    const outPattern = path.join(os.tmpdir(), `vf_${ts}_%02d.jpg`);
    exec(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}" 2>/dev/null`, (err, stdout) => {
      const duration = parseFloat(stdout?.trim()) || 30;
      const fps = 6 / duration;
      exec(`ffmpeg -i "${videoPath}" -vf "fps=${fps},scale=640:-1" -frames:v 6 -q:v 4 "${outPattern}" -y 2>/dev/null`, () => {
        const frames = [];
        for (let i = 1; i <= 6; i++) {
          const p = path.join(os.tmpdir(), `vf_${ts}_${String(i).padStart(2,'0')}.jpg`);
          if (fs.existsSync(p)) frames.push(p);
        }
        resolve(frames);
      });
    });
  });
}

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
