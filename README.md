# dfs-ev-demo

DFS/prop-betting analytics demo — real-time UI over a real EV pipeline (historical
hit rate + real odds/weather vs. mocked coverage data). See `CLAUDE.md` for the
full project brief and roadmap.

## Setup

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local`:

- **Odds API** (`ODDS_API_KEY`) — free tier key from [the-odds-api.com](https://the-odds-api.com).
- **Firebase** (`NEXT_PUBLIC_FIREBASE_*`, `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64`) — see the comments in `.env.example`.
- **Postgres / historical stats** (`DATABASE_URL`, `CRON_SECRET`) — see below.

```bash
npm run dev
```

## Historical player stats (Postgres + nflverse)

Real sample-window hit rates (base rate of the EV pipeline) are backed by
[nflverse](https://github.com/nflverse/nflverse-data)'s public NFL stats, synced
into a Neon Postgres database.

### Provider notes (nflverse)

- **Cost:** free, no API key. The actual CSV downloads (GitHub Releases
  assets) are unmetered static files. The idempotency check before that
  (asking GitHub's REST API for a release's `updated_at`) does hit a real,
  rate-limited endpoint — 60 requests/hour, unauthenticated (see
  [GitHub's rate-limit docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
  The sync job makes 2 of those calls per run, once daily — comfortably
  under the limit, but it isn't literally unlimited.
- **Coverage:** current season, current rosters only (see `db/schema.sql`'s
  header comment) — not a multi-season historical archive.
- **Freshness:** updated nightly after each game day during the season, plus
  additional passes on game days themselves, plus a Wednesday-night pass
  catching the NFL's own Monday–Wednesday stat corrections. The sync job
  (below) checks GitHub's release metadata before downloading anything, so it
  safely no-ops if nothing has actually changed since the last run.
- **License:** nflverse data is published for public/community use under the
  nflverse project's own terms — see their repository for specifics before any
  commercial use beyond this demo.

### One-time setup

1. **Provision Postgres.** In the Vercel dashboard: your project → Storage tab
   → Create Database → Neon (free tier). This auto-populates `DATABASE_URL`
   (and several related env vars) on Preview/Production — pull the value into
   `.env.local` yourself from Neon's own dashboard (not Vercel's, which hides
   it once marked sensitive).
2. **Create the schema:**
   ```bash
   psql "$DATABASE_URL" -f db/schema.sql
   ```
3. **Seed the player crosswalk** (maps a real player's Odds API name to their
   nflverse player ID — see the file's own header comment for why this is
   still a small manual table, not an automatic matcher; only players listed
   here get real historical stats behind the EV calc, see Fallback behavior
   below):
   ```bash
   psql "$DATABASE_URL" -f db/seed_crosswalk.sql
   ```
4. **Set `CRON_SECRET`** (any random value, e.g. `openssl rand -hex 32`) in
   both `.env.local` and the Vercel project's env vars (Production only —
   that's the only environment Vercel Cron actually triggers).

### Keeping it in sync

`vercel.json` schedules `/api/cron/sync-player-stats` once daily. Vercel Cron
sends its own `Authorization: Bearer $CRON_SECRET` header automatically, so no
manual trigger is needed once deployed. To run a sync manually (e.g. locally,
or to backfill immediately after setup) hit the route with that same header:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sync-player-stats
```

### Fallback behavior

If `DATABASE_URL` isn't set, or Postgres is unreachable, or the watched
player isn't yet in `player_crosswalk`, `/api/stream` falls back to an empty
`recentGameStats` array (logging a warning) rather than failing — a fresh
checkout without Postgres configured, or watching a player who hasn't been
crosswalked yet, still runs; the base-rate/recent-stat-average parts of the
EV calc are just honestly empty (0%, not a fabricated number) until that
player is added to the crosswalk.
