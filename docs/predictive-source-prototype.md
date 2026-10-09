# Bounded source qualification prototype

This is delivery 3 work in progress for [#52](https://github.com/ven2dev/dfs-ev-demo/issues/52#issuecomment-6054299022). It captures public nflverse research samples, retains exact private bytes and recomputes their selected projections offline. It produces **no feature batch, label, prediction or SQL observations**. The [source decision](predictive-data-sources.md), [operating policy](predictive-data-operations.md) and [synthetic persistence contract](predictive-ingestion.md) still apply.

## Commands and scope

Use Node 24 and an existing mode-0700 directory outside the checkout:

```sh
artifact_root=$(mktemp -d "${TMPDIR:-/tmp}/dfs-ev-52-source.XXXXXX")
npm run predictive:source -- capture --artifact-root "$artifact_root" --season 2026 --game-id 2026_06_CAR_PHI
npm run predictive:source -- verify --artifact-root "$artifact_root" --journal <sha256>.json --journal-bytes <byteSize>
```

The profile is intentionally restricted to sampled season **2026**. It does not qualify the prior two seasons, or reuse the different pre-2025 depth layout. The schedule sample includes earlier seasons only for source enumeration. The CLI validates arguments before registering the directory, loads no `.env` file and refuses ambient application/database, Neon and GitHub credentials. Public sample acquisition needs no API key. Neither command connects to PostgreSQL or starts an application job.

`capture` prints a terminal report and immutable journal reference. `captured` means all seven files passed byte integrity, registered headers and selected-column parsing; it does not mean the feeds are eligible predictors. `incomplete` includes any bounded header probe. `refused` means acquisition or qualification failed and subsequent feeds were not acquired. Every result has `featuresPublished: false`; partial and refused files remain private diagnostics. A failure to access the artifact store can also prevent writing the terminal journal. There is no automatic orphan deletion or retention cleanup.

`verify` checks exact journal/capture/reference fields, states, order, limits, timestamps, retained counts, every metadata/source hash, provider size/digest for full sources and the header/range of probes. It re-parses successful files and recomputes the entire qualification report and selected digest. A missing/changed file, invented publication, omitted qualification or inconsistent state refuses restoration. This is offline integrity verification; it neither authenticates an independently edited journal's origin nor supplies historical availability before the actual capture.

## Registered adapters

[`sourceAdapters.ts`](../src/lib/predictive/sourceAdapters.ts) and [`sourceHeaders.ts`](../src/lib/predictive/sourceHeaders.ts) register the exact full header/order observed on 2026-10-09 as `nflverse-csv-qualification-v1`. An added, missing, duplicate or reordered column fails closed. Full bases retain excluded columns only for private exact-byte verification; projections contain only the seven documented `RAW_ALLOWLISTS`. Scores, odds, fantasy points, provider efficiency metrics and other excluded fields never enter the selected projection.

Each asset uses `https://api.github.com/repos/nflverse/nflverse-data/releases/tags/<tag>` for release metadata and `https://github.com/nflverse/nflverse-data/releases/download/<tag>/<asset>` for bytes:

| Feed | Tag / exact asset | Observed source bytes | Parsed rows | Result |
| --- | --- | ---: | ---: | --- |
| Player counts | `stats_player` / `stats_player_week_2026.csv` | 2,011,144 | 4,517 | Complete sample |
| Team counts | `stats_team` / `stats_team_week_2026.csv` | 53,958 | 130 | Complete sample |
| Schedules | `schedules` / `games.csv` | 2,183,998 | 7,548 | Complete sample |
| Identifiers | `players` / `players.csv` | 7,298,117 | 24,844 | Complete sample |
| Weekly rosters | `weekly_rosters` / `roster_weekly_2026.csv` | 4,237,368 | 13,047 | Complete sample |
| Injuries | `injuries` / `injuries_2026.csv` | 157,433 | 1,398 | Complete sample; report-cycle semantics unqualified |
| Depth | `depth_charts` / `depth_charts_2026.csv` | 59,691,338 upstream; **4,096 retained** | 0 | Header only; over file budget |

These player/team asset names follow the [official stats loader](https://github.com/nflverse/nflreadr/blob/main/R/load_stats.R); older documentation's `player_stats_<season>.csv` and `team_stats_<season>.csv` are shorthand. The [weekly roster loader](https://github.com/nflverse/nflreadr/blob/main/R/load_rosters_weekly.R) uses the distinct weekly asset, rather than the application's season-roster sync. The [schedule loader](https://github.com/nflverse/nflreadr/blob/main/R/load_schedules.R) uses nfldata's `games.rds`; this prototype explicitly registers the nflverse-data CSV mirror and does not claim an independent schedule source.

Counts parse as strict bounded integers: explicit zero is observed, signed passing yards are preserved, blank/`NA` is null and invalid/decimal/overflow values are refused or reported unresolved. Schedule `gametime` is Eastern regardless of venue; IANA round-trip validation handles daylight saving and rejects repeated/nonexistent local times and invalid dates. Missing time remains unknown. Raw `LA` stays a source alias pending an explicit canonical team bridge.

Capture/availability timestamps are taken after the complete response body is read. Ingestion time follows the durable private write. Release `updated_at` is retained only as diagnostic metadata, with `sourcePublishedAt: null`; it cannot backdate row availability or establish original publication. A header-only response's timestamps describe that probe, never the complete upstream asset. Later recaptures produce later journals; no historical predictor versions or correction lineage are inferred from a current mutable download.

## Budget and observed cost

The transport permits only these ceilings; injected configurations can lower them. The CLI uses the defaults:

| Bound | Ceiling | Behavior |
| --- | ---: | --- |
| Requests including attempts and redirects | 28 | Stop before the next request |
| Complete response body | 8,000,000 bytes | Refuse advertised or streaming overflow |
| Consumed response bodies across metadata, source and retry reads | 20,000,000 bytes | Stop acquisition; consumed failed-attempt bytes still count |
| Parsed selected rows across feeds | 80,000 | Refuse before adding another row |
| Acquisition/parsing/qualification elapsed time | 90 seconds | Check between operations; network requests receive abort deadlines |
| Individual request | 15 seconds | Abort; retry only within remaining run/attempt budget |
| Attempts per logical request | 3 | Retry network failures, 408, 429 and selected 5xx; honor Retry-After or bounded exponential jitter |
| Oversized asset probe | At most 4,096 bytes | Require HTTP 206 and exact Content-Range; parse only the header |

Redirects are manual and counted, restricted to HTTPS GitHub/release-asset hosts. Redirect/error bodies are cancelled, not downloaded. Non-retryable HTTP failures, header drift, invalid UTF-8, truncation and byte/row violations fail closed. `responseBytesRead` counts bytes actually delivered to the client reader, including metadata and interrupted retries; it is **not wire traffic, TLS overhead or provider/CDN billing**. A streaming chunk that crosses a cap is counted and cancelled, so the refused metric may exceed the cap by that already-delivered chunk. Parsing and filesystem work are bounded by input sizes and checked between phases; the timer is not a process-kill watchdog. Peak RSS is measured for the process, not enforced as a memory ceiling.

The measured capture on **2026-10-09, 22:51:21–22:51:27 UTC** used 21 requests, 18,057,623 consumed response bytes, 51,484 parsed rows and 5,989 ms elapsed through qualification. Raw retained source bytes total 15,946,114. Seven metadata files add 2,111,509 bytes. The private directory has 16 files including journal/registration, totaling **18,068,656 logical file bytes**; filesystem allocation/replication are not included. Maximum process RSS was **485,916,672 bytes** (about 463 MiB).

Offline verification of those exact files passed in a separate Node process: 1.30 seconds wall, 1.44 seconds user CPU, 0.10 seconds system CPU and 400,785,408 bytes maximum RSS, measured by macOS `/usr/bin/time -l`. Parallel CPU accounting can exceed wall time. Acquisition CPU and separate retry/redirect counters were not instrumented; request totals include both. The measured RSS is substantial for this sample size, so larger or scheduled workloads require an explicit memory budget and profiling. This prototype is not a roster-scale indexed-query or hosting benchmark.

No paid provider, hosted job, cloud database or object store was used. This records local request/processing/retention quantities, not an all-in monthly price. Initial seed, multiple seasons, correction growth, pinned retention, scheduler, compute wake/tail, database rows/index/TOAST bytes, object operations/egress and hosted usage remain the operating policy's measurement gates. The 59.7 MB depth file needs a separately reviewed strategy/budget; the prototype does not expand its cap or treat a probe as coverage.

## Qualification findings and next work

For target `2026_06_CAR_PHI`, Eastern conversion gives **2026-10-18T17:00:00.000Z**. Source enumeration finds 17 games per season for PHI and CAR in each of 2024–2026. Those counts come from the same mutable schedule and **do not prove independent complete coverage**.

The sample has 148 QB statistics rows. Five player rows have missing identifier matches; there are no ambiguous identity keys in this sample. All sampled player/team rows join to the schedule, every player passing pair is numeric, and the summed player passing attempts/yards agree with each of the 130 team rows. This checks internal provider consistency, not official independent reconciliation or label finalization.

Weekly rosters enumerate **553 QB team/week candidates** across all statuses. Of those, 148 have a resolved statistics match, 404 have no match and one has an unresolved identity. All **553 remain participation-unresolved**: positive statistics do not qualify independent participation evidence, ACT does not establish a game-day active list and a missing statistics row does not establish absence/zero. Conflicting roster/statistics/identifier keys are exposed as ambiguous rather than resolved arbitrarily. Candidates are not a proven complete market population.

The qualification report returns `unavailable-inputs`, `populationCoverage: unqualified`, `modelValidated: false` and these concrete requirements:

1. Qualify a permitted completed-event source and independent offensive-participation evidence, including zero-opportunity and special-teams-only candidates. Record first captured completion confirmation separately from actual physical end time. Evaluate the conditional PFR/gamebook routes under their existing rights and bridge gates; automated acquisition of either is not authorized by this prototype. If they cannot meet the contract, compare a licensed sample before considering paid access.
2. Establish independent schedule enumeration and canonical game/team bridges, including aliases, reschedules and ambiguous IDs. A complete CSV download is not that evidence.
3. Establish exact effective membership bounds, complete roster/population enumeration, and injury report-cycle/status-removal semantics. Weekly grain and current injury rows cannot supply those timestamps by inference.
4. Address depth size/freshness under a reviewed acquisition/memory budget, then sample historical stats/roster feeds separately. Current-source files do not qualify strict historical cutoff coverage.
5. Only after those contracts pass, design real-source append-only publication and official-label finalization. Migration v3 remains synthetic-only; no real raw payload is inserted through it. Remaining market adapters, modeling sufficiency (#54), serving/public rights and hosted activation remain separate work.

The research profile references the existing `nflverse-internal-research-2026-10-05` source decision. Header registration is not a new license clearance, public/commercial display permission, bulk redistribution approval or permission to acquire conditional PFR/FTN/official data. Exact bases remain private; only schema names, implementation, synthetic tests and aggregate evidence are committed.

## Evidence and validation

Private evidence retained locally:

- Artifact directory: `/private/tmp/dfs-ev-52-source-proof.utpDdL`.
- Journal: `f496e74d6823d5507b301568d2c9c1dbc6f562fe93c8cbb52f621bd6674a5b31.json`, **10,967 bytes**. Keep every referenced file for offline verification; temporary storage is not a durable backup.
- Capture report: `/private/tmp/dfs-ev-52-source-capture-report.json`; offline result: `/private/tmp/dfs-ev-52-source-verified.json`.
- Independent Python `csv`/SHA-256/ZoneInfo check: `/private/tmp/dfs-ev-52-source-parity.py` and `/private/tmp/dfs-ev-52-source-parity.json`; process measurement: `/private/tmp/dfs-ev-52-source-verify-metrics.txt`.

Both implementations reproduce selected projection digest `20b3612bb591839f0e6e4238b7f7da122c2cefefacfcf27cf8cbca28a9052443`, source hashes/row counts, QB roster/statistics partition, five missing player identities, zero player/team sum mismatches and the target UTC kickoff. Python parses the retained bytes independently, projects the documented allowlist and checks hand-specified observed counts; it does not call the TypeScript implementation. It covers this sample, not every edge case or independent source truth.

The new 72 synthetic tests cover CSV quoting/BOM/newlines, forbidden-column projection, exact header drift, row/record bounds, missing/zero/signed numeric values, DST and invalid dates; hand-calculated qualification counts and conflict/missing identities; request/redirect/retry/deadline/timeout/byte/encoding/truncation behavior; successful/probe/refused journals; rehashed journal corruption, raw tampering/missing files, CLI validation before directory registration and preservation of the synthetic artifact cap. The hand-built source fixture has nine rows across seven feeds and two QB roster candidates; it is not a captured NFL outcome. All 182 predictive/storage/source tests pass.

Final local validation passed on Node 24.18.1: typecheck, lint, 831 jsdom + 374 Node tests, all mandatory disposable PostgreSQL cases (74 Node + 29 Vitest), DB target/bootstrap/report guards, aggregate CI-gate tests, Firestore rules and production build. The production dependency audit found zero vulnerabilities. Existing v1/v2/v3 migration artifacts were not changed. The app loopback tests and Docker/process-counter checks needed execution outside the filesystem sandbox; they then passed. These are local checks, not hosted CI or a hosted activation approval.
