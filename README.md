# dfs-ev-demo

DFS/prop-betting analytics demo — real-time UI over a real EV pipeline (historical
hit rate + real odds/weather vs. mocked coverage data). See `CLAUDE.md` for the
full project brief and roadmap.

## Setup

Node.js 24 is the supported local, CI, and production runtime. Java 21 is also
required for the local Firestore security-rules emulator test. With `nvm`, the
checked-in Node version contract can be selected before installing dependencies:

```bash
nvm use
npm install
cp .env.example .env.local
```

## Quality checks

Pull requests and pushes to `main` run the same Node 24 quality contract in
GitHub Actions. It requires no production credentials and makes no paid API
calls. Run it locally before pushing:

```bash
nvm use
npm ci
git diff --check
npm run typecheck
npm run lint
npm run test:ci-gate
npm test
npm run test:db:guard
npm run test:db:local
npm run test:firestore-rules
npm run build
npm audit --omit=dev --audit-level=critical
```

CodeQL analyzes JavaScript/TypeScript on PRs, pushes to `main`, and weekly.
Its analysis job uses no production application credentials and makes no paid
provider calls. Dependency updates follow the
[review guide](docs/dependency-updates.md); report vulnerabilities through the
[security policy](SECURITY.md). Maintainer validation, required-check rollout,
notification evidence, and disabled-schedule recovery are covered in the
[security operations runbook](docs/security-operations.md).

Disposable PostgreSQL integration tests use Docker Desktop and throwaway local
credentials. Run `npm run test:db:local` to provision, test, and clean up, or
`npm run test:db:down` to remove resources after an interruption. See the
[database testing guide](docs/database-testing.md) for environment guards,
schema bootstrap, and test scope.

CI runs `App checks` and `DB integration` in parallel. The required `CI` gate
runs after both jobs and passes only if both succeed; failed, cancelled, or
skipped jobs fail the gate. Local database checks require a running Docker
service; the gate's regression check executes its actual shell script locally.

Keep the relay worktree's `.env.local` fixture-only (`ODDS_DATA_SOURCE=fixture`).
For application runs with real providers, load the following variables from a
private file outside the worktree in your own terminal, separate from the agent
session:

- **Odds API** (`ODDS_API_KEY`) — free tier key from [the-odds-api.com](https://the-odds-api.com).
- **Firebase** (`NEXT_PUBLIC_FIREBASE_*`, `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64`) — see the comments in `.env.example`.
- **Postgres / historical stats** (`DATABASE_URL`, `CRON_SECRET`) — see below.

Vercel Preview is deliberately isolated from Production and uses deterministic
odds fixtures. See [Preview environment isolation](docs/preview-environment.md)
for the environment matrix, deployment-protection behavior, ownership, and
credential-rotation procedure.

```bash
npm run dev
```

## Firebase client gRPC override

Issue [#69](https://github.com/ven2dev/dfs-ev-demo/issues/69) pins
`@grpc/grpc-js` to `1.14.5` only under `@firebase/firestore`. The client
Firestore SDK declares `~1.9.0`, which resolves to vulnerable `1.9.16`;
Firebase `12.19.0` / Firestore `4.17.2` still declare that same range, so a
normal Firebase upgrade alone does not remove the findings. Version `1.14.5`
fixes [unauthorized certificate handling](https://github.com/grpc/grpc-node/security/advisories/GHSA-m9gg-hp2v-232j)
and [handler error disclosure](https://github.com/grpc/grpc-node/security/advisories/GHSA-f596-whhp-79r4).
The `1.14.0` through `1.14.4` releases are also affected.

This override intentionally crosses Firestore's declared minor-version range.
Application code uses the client SDK for Authentication and the Admin SDK for
Firestore; `npm run test:firestore-rules` exercises the client Firestore SDK
under Node against the local emulator. Keep that compatibility check and
`npm test` (including the Admin runtime check) passing. The override is not
global; Admin and tooling already resolve to `1.14.5` and may deduplicate it.

Re-check the upstream gRPC requirement on every Firebase bump. Remove the
override once the selected Firebase/Firestore release natively resolves to a
patched version, then regenerate the lockfile and verify the production audit,
`npm ls`, and the complete quality checks above without it.

## Historical player stats (Postgres + nflverse)

Real sample-window hit rates (base rate of the EV pipeline) are backed by
[nflverse](https://github.com/nflverse/nflverse-data)'s public NFL stats, synced
into a Neon Postgres database.

The future independent projection has a separate
[predictive source decision](docs/predictive-data-sources.md),
[feature/cutoff/identity contract](docs/predictive-feature-contract.md), and
[operating-cost and handoff plan](docs/predictive-data-operations.md) from #49.
All nine market candidates support prospective predictor capture; complete
outcome coverage remains blocked on qualified participation evidence. Current
revised historical files are exploratory, public/commercial display rights
remain conditional, and no projection model or new ingestion job ships here.

### Provider notes (nflverse)

- **Cost:** free, no API key. The actual CSV downloads (GitHub Releases
  assets) are unmetered static files. The idempotency check before that
  (asking GitHub's REST API for a release's `updated_at`) does hit a real,
  rate-limited endpoint — 60 requests/hour, unauthenticated (see
  [GitHub's rate-limit docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
  The sync job makes 3 of those calls per run, once daily — comfortably
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
3. **Set `CRON_SECRET`** (any random value, e.g. `openssl rand -hex 32`) in
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

The first successful run synchronizes both current-season game stats and the
current roster. Run it once after creating the schema so unseen Odds API player
names can be resolved without any manual seed data.

### Identity safety behavior

The live model never represents unavailable history as a valid 0% result. An
unseen Odds API player name is matched only within the selected event's two
teams and only against positions compatible with that prop market. A unique,
high-confidence match is cached in `player_crosswalk`; an ambiguous or
low-confidence identity returns `422` without inserting anything. A missing
roster snapshot or an unreachable Postgres database returns `503`. The app
never substitutes mock history or fabricates an EV result.

## Shared live odds/weather cache

`/api/stream` connections schedule independently, but their cost-bearing
inputs are shared across processes through `live_prop_inputs_cache`. The key
is `(sport_key, event_id, market_key, player_name)`: bookmaker and direction
are intentionally excluded because one Odds API response contains every book
and both Over/Under outcomes for that player prop.

The cache TTL matches the 90-second live polling interval. A 30-second
Postgres refresh lease ensures concurrent viewers—including viewers handled
by different serverless instances—produce one Odds API call and one
Open-Meteo call for that key per interval. An active holder renews that lease
every 10 seconds. Both upstream requests share one cancellation scope and a
20-second deadline, so a failed or hung request cannot keep running after the
lease is released. Followers wait for and reuse the lease holder's
observation; a crashed holder can still be replaced after the lease expires.

Run `psql "$DATABASE_URL" -f db/schema.sql` after pulling schema changes and
before deploying the stream route. The schema command is idempotent.

## Same-line market consensus

The live EV pipeline compares its model probability with a versioned market
baseline: `exact-line-median` v1. The selected sportsbook supplies the target
line. At that exact point, each bookmaker's complete Over/Under pair is
devigged independently, then the median Over probability is used as the
consensus; Under is derived as its complement. The median limits the influence
of one unusually priced book without assigning unsupported quality weights.

Different points are never mixed or translated. Quotes with non-finite decimal
prices, prices at or below 1, or incomplete pairs do not contribute. One valid
book remains usable and is labeled as a one-book result rather than rejected by
an arbitrary minimum. Every live tick exposes the method, version, and
contributing-book count, and the UI describes that count as coverage rather
than confidence. This transparent baseline can later be compared with other
aggregation methods using historical snapshots from issue #41.

## Historical odds observations

The append-only odds collector records scheduled, discovery, and genuinely
refreshed live responses for movement analysis and future model calibration.
It supports a one-game free-tier pilot and an explicit full-slate paid profile;
both use the same immutable observation and content-addressed quote-set schema.

See [Odds observation collector](docs/odds-collector-operations.md) for cadence,
quota estimates and degradation, Hostinger cron setup, data provenance,
retention, and database-size measurement. Apply `db/schema.sql` before enabling
the collector; the profile defaults to `disabled`.

## Creator corpus tools (owner-run)

Local, owner-run commands build and review the expected-video manifest for the
creator corpus: official YouTube Data API discovery (metadata only), a
loopback-only review page, and an append-only decision log. They are not part
of the deployed app, a build, CI or any scheduled job, and all inputs and
outputs must be JSON files outside this repository. See the
[creator corpus runbook](docs/creator-corpus-operations.md) before use.
