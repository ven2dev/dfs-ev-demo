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
T-15m checkpoints; a Sunday or Monday game has all seven. The T-15m result is
only labeled a closing candidate when it was captured no more than 30 minutes
before kickoff.

Priority targets are generic event/market targets, independent of creator
recommendations. They schedule immediately and hourly until T-6h, then every
five minutes until kickoff. This density is intentionally expensive and must
only be enabled for markets actively needed by product analysis.

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
  thirteen Sunday games, and one Monday game schedules 102 event requests, or
  at most 918 credits. A 16-game version schedules 109 requests, or at most
  981 credits. Across 18 regular-season weeks, that is roughly 16,524–17,658
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
then T-15m, T-6h, and Friday final-practice checkpoints, then the ordinary free
pilot and paid-baseline checkpoints. At zero reported credits, no billed work
is claimed. Unknown quota is treated as scarce rather than unlimited.

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

The endpoint returns a compact execution summary. A non-2xx response, repeated
`failed` or `leaseLost` counts, `unknownCostAttempts`, or a declining quota near
the reserve requires investigation. Request-level evidence remains available
in `odds_api_request_log`, while checkpoint outcomes remain in
`odds_collection_checkpoints`.

## Data dictionary and as-of semantics

| Table | Purpose |
| --- | --- |
| `odds_observations` | Immutable upstream response identity, capture time, source, event, checkpoint, and quota |
| `odds_observation_markets` | Per-request market status and link to returned content |
| `odds_observation_book_markets` | Provider `last_update` per bookmaker/market at that observation |
| `odds_quote_sets` | Unique event/market content hashes |
| `odds_quotes` | Normalized Over/Under price and point rows within a quote set |
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
validation. There is no weekly cleanup and no automatic deletion policy.
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
