# Odds observation collector

The collector records immutable pregame market evidence for later movement,
calibration, and model evaluation. It does not replace the short-lived serving
caches and it does not overwrite an older observation with a newer one.

Each successful upstream event response creates an `odds_observations` row and
one status row for every requested market. Returned prices are normalized into
content-addressed `odds_quote_sets`; when two observations contain identical
quotes for an event and market, both timestamps remain but they reuse the same
quote rows. Empty, unavailable, and invalid markets are recorded explicitly so
absence is not mistaken for a zero or silently filled from another time.

## Profiles and cadence

`ODDS_COLLECTION_PROFILE` is an explicit deployment switch:

| Value | Baseline selection | Intended use |
| --- | --- | --- |
| `disabled` | None | Local development and deployments not ready to collect |
| `free-pilot` | Latest Sunday game, or `ODDS_FREE_PILOT_EVENT_ID` | 500-credit free tier |
| `paid-baseline` | Every event in the current NFL slate | 20K paid plan |

For each selected event, the calendar-aware baseline schedules one 8 PM
America/New_York checkpoint on Tuesday through the day before kickoff, then
T-6h and T-15m. A Thursday game therefore has Tuesday, Wednesday, T-6h, and
T-15m checkpoints; a Sunday game has seven checkpoints, while a Monday game
also receives Sunday evening and has eight. The T-15m result is only labeled a
closing candidate when it was captured no more than 30 minutes before kickoff.

The first automatic free-pilot choice is stored in
`odds_free_pilot_selections` and remains pinned through schedule flexes. An
explicit `ODDS_FREE_PILOT_EVENT_ID` deliberately replaces that week's pin and
supersedes the old event's unfinished checkpoints; completed evidence is never
deleted. The override must belong to the current NFL week. Update or clear it
at weekly rollover, otherwise the collector returns an error instead of
silently spending credits on a different event.

Priority targets are generic event/market targets, independent of creator
recommendations. They schedule immediately and hourly until T-6h, then every
five minutes until kickoff. `ODDS_PRIORITY_FAR_INTERVAL_MS` and
`ODDS_PRIORITY_ACTIVE_INTERVAL_MS` make those two intervals deployment
configurable. This density is intentionally expensive and must only be enabled
for markets actively needed by product analysis. Issue #41 provides the
storage and scheduling foundation only; no production feature creates a
priority target yet.

The route can run frequently without producing duplicate observations. A
durable checkpoint ledger claims only due work, uses expiring leases for
overlapping invocations, retries within the checkpoint's validity window, and
suppresses work at or after kickoff. It never reconstructs a missed historical
checkpoint using current prices.

## Quota policy and estimates

The collector requests the nine currently trackable two-way player-prop
markets in one US-region event request. The provider charges for unique markets
returned, so a baseline call costs at most nine credits. The free `/events`
planning call costs zero credits. These rules and the response headers are
documented by [The Odds API](https://the-odds-api.com/liveapi/guides/v4/).

The current plans, checked 2026-10-02, are 500 credits/month at no charge and
20,000 credits/month for $30 USD. Prices and quotas can change; verify the
[provider pricing page](https://the-odds-api.com/) before upgrading.

- Free pilot: one Sunday event x seven checkpoints x at most nine credits =
  at most 63 baseline credits/week, approximately 274 in an average month.
  Discovery, live viewing, retries, and priority targets share the same quota.
- Paid baseline: a representative 15-game week with one Thursday game,
  thirteen Sunday games, and one Monday game schedules 103 event requests, or
  at most 927 credits. A 16-game version schedules 110 requests, or at most
  990 credits. Across 18 regular-season weeks, that is roughly 16,686–17,820
  credits before playoffs, interactive traffic, retries, or priority targets.
- Priority example: tracking one market from Tuesday until a Sunday kickoff can
  approach roughly 180 requests, or 180 credits. Tracking all nine markets at
  that cadence can approach 1,620 credits for one event. Priority collection
  must therefore remain narrow and deliberate.

Those are upper-bound planning estimates: the provider bills markets returned,
not merely requested, and empty data does not consume quota. The durable
`odds_api_request_log` records every slate, discovery, live, scheduled, and
direct provider attempt, its outcome, source, requested markets, HTTP status,
and the provider's `x-requests-*` quota headers. It never stores the API key or
request URL. Use measured values rather than estimates once the pilot runs:

```sql
SELECT
  date_trunc('week', requested_at) AS week,
  source,
  COUNT(*) AS calls,
  COUNT(*) FILTER (WHERE outcome <> 'success') AS failed_calls,
  COALESCE(SUM(quota_last), 0) AS known_credits,
  COUNT(*) FILTER (WHERE quota_last IS NULL) AS unknown_cost_calls
FROM odds_api_request_log
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
```

`ODDS_COLLECTION_QUOTA_RESERVE` is a prioritization threshold, not a guarantee
that credits can never fall below that number. As the reported remaining quota
approaches the threshold, ordinary work is excluded and each invocation claims
at most one affordable high-priority checkpoint. Priority targets rank first,
then T-15m, T-6h, and Friday final-practice checkpoints, then the ordinary paid
full-slate baseline, and finally exploratory free-pilot checkpoints. At zero
reported credits, no billed work is claimed. Unknown quota is treated as scarce
rather than unlimited. Explicit user refreshes remain outside this scheduled
queue and use the existing cache/cooldown controls.

A checkpoint permits at most three attempts. If a paid fetch succeeds but its
observation cannot be persisted, the raw response is not retained outside that
request and a later retry must fetch again. The worst-case exposure is therefore
27 credits for a nine-market checkpoint. The work ledger and request telemetry
make that cost visible; the retry bound favors recovering missing evidence over
silently marking it complete.

## Deployment and Hostinger trigger

Apply `db/schema.sql` to the configured Postgres database before enabling the
collector. Set `ODDS_API_KEY`, `DATABASE_URL`, `CRON_SECRET`, and the selected
profile only in the server deployment. Never expose them with a
`NEXT_PUBLIC_` prefix.

The app remains on its existing Next.js/Postgres stack. The Hostinger Business
Web Hosting plan is suitable only as an external cron trigger; its shared
CloudLinux/MySQL environment is not the collector runtime or database. Configure
its one custom cron job to call the deployed HTTPS route every five minutes:

```bash
curl --fail --silent --show-error --max-time 55 \
  -H "Authorization: Bearer REPLACE_WITH_CRON_SECRET" \
  https://REPLACE_WITH_DEPLOYED_HOST/api/cron/collect-odds
```

The five-minute trigger is a wake-up frequency, not a five-minute baseline
snapshot schedule. The database ledger determines which work is actually due.
Five minutes is required if a priority target needs the approved T-6h cadence.
Use the same strong secret in Hostinger and the app deployment, restrict access
to the Hostinger account, and rotate both values together if it is exposed.

The collector endpoint returns a compact execution summary. A non-2xx response,
repeated `failed` or `leaseLost` counts, `unknownCostAttempts`, or a declining
quota near the reserve requires investigation. Request-level evidence remains
available in `odds_api_request_log`, while checkpoint outcomes remain in
`odds_collection_checkpoints`.

## Health monitoring and incident lifecycle

`GET /api/health/odds-collector` is a read-only Postgres health check. It never
calls The Odds API. Authorize it with `Authorization: Bearer ODDS_HEALTH_SECRET`;
use a different random value from `CRON_SECRET` so the monitor cannot invoke
the quota-bearing collector route. A healthy check returns HTTP 200, an
operationally unhealthy check returns 503, a query or configuration failure
returns 500, and an unauthorized request returns 401. Responses contain only
stable reason codes, never quota values, event ids, timestamps, URLs, database
details, or credentials.

The expected Production profile is deliberately hard-coded as `free-pilot`.
Moving to `paid-baseline` therefore requires a coordinated health-contract and
operations-guide change; changing only the environment variable makes the
monitor fail closed. The health query checks:

- a current-week durable free-pilot pin;
- a 15-minute pin-creation grace at the Tuesday week boundary, ending early as
  soon as the first new-week scheduled wake occurs;
- a successful scheduled slate wake no more than 20 minutes old;
- successful scheduled event-odds calls with unknown cost in the last 24 hours;
- failed current-pin checkpoints with at least two attempts that remain inside
  their due window;
- current-pin checkpoints terminally skipped after exhausting attempts or
  their retry window;
- claims expired by more than 10 minutes, allowing the next five-minute wake to
  recover an ordinary abandoned lease first;
- pinned-event checkpoints that expired even though their window ended after
  the pin was created, excluding legitimate pre-activation backlog;
- unfinished future checkpoints from another profile and active priority
  targets; and
- whether the collector's shared quota policy can run the next pinned-event
  checkpoint. Degraded quota is a warning until it actually blocks that work.

The `Collector Health` GitHub Actions workflow initially supports manual
dispatch only. Activation deliberately follows this order: deploy the health
route, prove one expected missing-wake incident, enable and verify the
Hostinger trigger with explicit operator approval, and only then add the
ten-minute schedule. This prevents a knowingly red monitor from training the
operator to ignore alerts.

GitHub stores both `ODDS_HEALTH_URL` and `ODDS_HEALTH_SECRET` as Actions
secrets. Each health request permits two bounded transport retries before it is
treated as unreachable. The workflow publishes only reason codes to one issue
titled `[ops] Collector health alert`. The first unhealthy transition opens the
issue and fails once, producing a failed-workflow notification. A newly
observed unhealthy reason also fails once while that incident remains open, so
a stale wake cannot hide behind an earlier missed checkpoint. Unchanged
persistent reasons update the issue without repeated failure emails; warnings
use the same issue without failing. Recovery closes it, and a later incident
opens a new issue.
The workflow has only `issues: write` permission and does not check out code,
install dependencies, or receive database/provider credentials.

Enable [GitHub Actions email or web notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications),
preferably failed workflows only. [Scheduled-workflow notifications](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)
go to the user who created the schedule or most recently changed its cron
expression, so a future cron editor also inherits notification ownership.
[GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
can be delayed or dropped under load, and public-repository schedules disable
after 60 days without repository activity. These are accepted pilot
limitations; issue #62 owns the longer-term independent production-health
design.

To stop collection immediately, disable the Hostinger cron job. Then set
`ODDS_COLLECTION_PROFILE=disabled` in Production and redeploy as defense in
depth; the disabled collector returns before making a provider request. Disable
the scheduled health workflow during a planned shutdown because profile drift
is intentionally unhealthy. Never delete observations, request telemetry,
checkpoints, or the weekly pin as part of shutdown.

## Data dictionary and as-of semantics

| Table | Purpose |
| --- | --- |
| `odds_observations` | Immutable upstream response identity, capture time, source, event, checkpoint, and quota |
| `odds_observation_markets` | Per-request market status and link to returned content |
| `odds_observation_book_markets` | Provider `last_update` per bookmaker/market at that observation |
| `odds_quote_sets` | Unique event/market content hashes |
| `odds_quotes` | Normalized Over/Under price and point rows within a quote set |
| `odds_free_pilot_selections` | Durable one-event selection per NFL week for the free pilot |
| `odds_priority_targets` | Explicit dense event/market collection requests |
| `odds_collection_checkpoints` | Durable scheduled-work, lease, retry, cost, and outcome ledger |
| `odds_api_request_log` | Sanitized telemetry for every provider request attempt |

Historical consensus queries select exactly one observation at or before the
requested cutoff, then evaluate the exact player and exact line only inside
that observation. They never combine books across timestamps and never search
older observations to fill a market missing from the selected snapshot. The
result reports observation age, source, contributor count, and whether it
qualifies as a closing candidate.

## Retention and storage measurement

Keep the complete regular season and postseason online through model
validation, including the associated request telemetry. There is no weekly
cleanup and no automatic deletion policy.
Content-addressed quote sets reduce duplicate price storage without deleting
observation timestamps or market-availability evidence.

Storage depends primarily on how many unique quote sets the books produce and
how many player/book/line outcomes each contains, so a trustworthy byte
forecast requires pilot data. Before changing retention or buying database
capacity, record the actual table and index sizes:

```sql
WITH collector_tables(table_name) AS (
  VALUES
    ('odds_observations'),
    ('odds_observation_markets'),
    ('odds_observation_book_markets'),
    ('odds_quote_sets'),
    ('odds_quotes'),
    ('odds_free_pilot_selections'),
    ('odds_priority_targets'),
    ('odds_collection_checkpoints'),
    ('odds_api_request_log')
)
SELECT
  table_name,
  pg_size_pretty(pg_relation_size(to_regclass('public.' || table_name))) AS table_size,
  pg_size_pretty(pg_indexes_size(to_regclass('public.' || table_name))) AS index_size,
  pg_size_pretty(pg_total_relation_size(to_regclass('public.' || table_name))) AS total_size
FROM collector_tables
ORDER BY pg_total_relation_size(to_regclass('public.' || table_name)) DESC;
```

Run that query after the first full pilot week and again after four weeks. The
weekly delta supplies a defensible regular-season/postseason projection and
shows whether quote-set reuse is delivering the expected savings. Until those
measurements exist, keep Postgres as the source of truth and do not move this
relational workload to Hostinger MySQL or silently shorten retention.

## Initial live verification

The schema and bounded collector path were verified on 2026-10-02 against the
configured Postgres database and The Odds API:

- Profile: `free-pilot`, one-claim limit, zero verification-only reserve.
- Event: Detroit Lions at Carolina Panthers
  (`a73a76599a4f3422803e57bd8f61b626`), kickoff
  `2026-10-05T00:20:00Z`.
- Completed checkpoint: `thursday-evening`; scheduled observation
  `b3cf9d0f-5446-4fbf-b5e2-d44524b984bd`, captured
  `2026-10-02T18:46:55.924Z`. A bounded discovery refresh created observation
  `4ed44150-97ab-4a70-9e35-da3511324f70` at
  `2026-10-02T18:52:17.443Z`.
- Provider result: both HTTP 200 responses contained all nine requested
  markets and 382 normalized quote rows.
- Quota: the slate request reported zero cost; the scheduled and discovery
  event-odds requests each reported exactly nine credits. Remaining quota was
  478 after the two bounded responses.
- Work ledger: one claim completed, no failure, retry, skip-after-claim, or
  lease loss. The already-expired Tuesday and Wednesday windows were marked
  `due-window-expired` without making retrospective requests; four future
  checkpoints remained pending.
- Reuse and integrity: the two genuine observations remained distinct, while
  all nine unchanged market payloads referenced the same nine quote-set IDs.
  Stored normalized quotes remained 382 rather than doubling to 764, and no
  duplicate `(event_id, market_key, content_hash)` keys existed. A six-book
  exact-line sample was present for both Bryce Young and Jared Goff
  passing-touchdown props at 1.5.
- Initial allocated table-and-index size across the then-eight collector tables
  was 488 kB before the durable pilot-selection table was added. This is only a
  post-verification baseline, not a growth forecast.

No credentials, request URLs, or API keys were persisted in the verification
telemetry.
