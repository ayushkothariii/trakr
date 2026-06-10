# trackr — self-hosted install attribution

A free alternative to the paid "custom alias" tier of link shorteners like
LinkTwin. Generate deep links with your own attribution aliases, share them in
organic posts on any platform, and see **clicks and real app installs** per alias.

- **Android:** deterministic, exact attribution via the Play Install Referrer.
- **iOS:** probabilistic attribution via first-party fingerprint matching (the
  same approach every paid SDK uses — Apple offers nothing better).
- **Deferred deep links:** after install, open the app to the screen the link pointed at.
- No third-party SDK, no per-install fees, your data stays in your own database.

## Why this is free when LinkTwin charges for it
The "alias" you'd pay for is just a tag carried through the Play Install Referrer
(Android) or matched server-side (iOS). Those are platform mechanics, not a
premium product. The only thing you need that a hosted tool gives you is *a
server with a stable URL* — which you get for free on the tiers below.

## What you must do that no tool can skip
Real **install** attribution (vs. just counting clicks) needs a few lines inside
your app to report the install back. See `integrations/android-kotlin.md` and
`integrations/ios-swift.md`. This is true for LinkTwin, Branch, and AppsFlyer too.

---

## Run locally
```bash
npm install
ADMIN_TOKEN=some-long-secret npm start
# open http://localhost:3000  → enter the token
```
Requires Node 22.5+ (uses Node's built-in SQLite — no native build, one dependency).

## Deploy (pick one)
All of these give you a stable HTTPS domain on a free/cheap tier.

**Render / Railway / Fly.io (long-running Node — recommended)**
- Start command: `npm start`
- Set env var `ADMIN_TOKEN` to a long random string.
- Attach a persistent disk and point `DB_PATH` at it (e.g. `/data/data.db`) so
  click/install history survives redeploys.

**Docker / any VPS**
```bash
docker build -t trackr .
docker run -d -p 3000:3000 -e ADMIN_TOKEN=some-long-secret -v $PWD/data:/app/data trackr
```

> Don't use plain serverless (Vercel/Netlify functions) as-is: the SQLite file
> won't persist between invocations. Use a long-running host, or swap the storage
> in `db.js` for a hosted database.

## Use it
1. Open the dashboard, enter your `ADMIN_TOKEN`.
2. Create a link: set an **alias** (e.g. `diwali-insta`), your Android package
   name, and your iOS App Store ID.
3. Share `https://YOUR-DOMAIN/l/diwali-insta` in the post.
4. Add the app-side snippet (one-time) from `integrations/`.
5. Watch clicks and installs land per alias, split by exact (Android) vs.
   estimated (iOS).

Make a different alias per post/channel (`yt-jan-review`, `x-launch`,
`reddit-r-androiddev`) to compare which organic sources actually convert.

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/l/:alias` | – | smart redirect + click log |
| POST | `/api/attribute/android` | – | app reports Play referrer |
| POST | `/api/attribute/ios` | – | app first-launch fingerprint check |
| GET | `/api/links` | Bearer | list links + counts |
| POST | `/api/links` | Bearer | create link |
| DELETE | `/api/links/:alias` | Bearer | delete link |
| GET | `/api/stats/:alias` | Bearer | per-alias breakdown |

## Privacy
Raw IPs are never stored — only a salted-by-UA SHA-256 hash used briefly for iOS
matching. No IDFA/GAID, no ATT prompt required. Mind local rules (GDPR, India's
DPDP Act) and disclose attribution in your privacy policy.
