# Local predictive cutoff replay proof

This is delivery 1 of [#52's implementation proposal](https://github.com/ven2dev/dfs-ev-demo/issues/52#issuecomment-6054299022): executable contracts and a synthetic passing-yards replay. Review this result before implementing persistent ingestion. The [feature contract](predictive-feature-contract.md), [source decision](predictive-data-sources.md) and [operating policy](predictive-data-operations.md) continue to govern subsequent work.

## Run and review

Use the repository's Node 24 environment and installed dependencies:

```sh
npm run predictive:demo
npx vitest run --config vitest.node.config.ts tests/predictive
```

The command constructs synthetic artifacts in memory, verifies their exact byte digests, and prints a JSON report. It loads no environment file and makes no network, filesystem-write or database request. It refuses ambient application/remote migration credentials, database test configuration and extra arguments. No API key or console setup is needed.

The report contains `capturedA`, `replayA`, `laterB`, and `unavailable`. All player IDs, event UUIDs, counts, times, completion and membership evidence are synthetic. These are technical fixtures, never nflverse qualification evidence.

| Scenario | Cutoff (UTC) | Last-4 player attempts / yards / pooled yards per attempt | Expected result |
| --- | --- | --- | --- |
| Capture A only | 2026-10-08 12:00 | 100 / 700 / 7 | `ready-inputs` |
| Capture A plus later correction B, same cutoff | 2026-10-08 12:00 | 100 / 700 / 7 | Same bundle and input digest as A |
| Later cutoff selects B | 2026-10-08 14:00 | 100 / 720 / 7.2 | `ready-inputs`, B predecessor and correction recorded |
| Later completion evidence becomes unresolved | 2026-10-08 14:00 | Newest game withheld; older game does not fill its slot | `unavailable-inputs` with completion/history reasons |

Capture A is at 2026-10-07 12:00 UTC; correction B is at 2026-10-08 13:00 UTC. The target kickoff is 2026-10-11 17:00 UTC. Both queried cutoffs precede it. Synthetic completion evidence was first observed on Oct 7; the scheduled rest result is still 168 hours from kickoff to kickoff, not a duration starting at that late observation.

Both usable bundles explicitly say `modelValidated: false`, `populationCoverage: unqualified` and `usage: synthetic-internal-research`. `ready-inputs` means only that the requested fixture inputs passed the contract. It supplies no projection, calibrated distribution, participation probability or opponent coefficient.

## Executable semantics

`buildPassingYardsBundle(dataset, request)` accepts a GSIS player, lowercase v4 canonical event UUID, strict UTC cutoff/computation instants and a named candidate. `player-opponent-v1:player_pass_yds` returns separate player, target-team and opponent summaries. The opponent group uses offenses that previously faced the target opponent; it never uses that opponent's own passing offense. `stats-v1:player_pass_yds` must be requested explicitly and omits team/opponent and scheduled-rest enrichment. An enriched failure cannot silently select it.

The version `passing-yards-replay-v1` defines these transformations:

| Output | Inputs / transformation | Unit |
| --- | --- | --- |
| `attemptsSum`, `attemptsPerGame` | Explicit per-game attempts, summed; divide by observed game count for volume | attempts; attempts/game |
| `passingYardsSum`, `passingYardsPerAttempt` | Paired explicit per-game yards/attempts; sum yards divided by sum attempts | yards; yards/attempt |
| `team` summaries | Target team's own eligible prior game totals | Same units; separate denominators |
| `opponent` summaries | Other offenses facing the target opponent in eligible prior games | Same units; separate denominators |
| `scheduledRestHours` | Target-team scheduled kickoff pair divided by 3,600,000 milliseconds | hours; diagnostic enrichment |

Every group has last-4/8/16 windows within the target's REG or POST sequence and current/prior-two season range. Summaries retain expected slot IDs, observed per-game values, date ranges, numerator/denominator sums, excluded counts and reasons. `unknownGames` is the subset of excluded slots with unresolved/missing required evidence; confirmed absent participation remains a known exclusion. Short history is visible and model sufficiency remains #54's decision. A missing newest game stays in its slot; the window does not reach farther back to replace it. Zero counts and signed integer yards remain observed values; blank fields stay null. Zero pooled exposure has no efficiency ratio and withholds a required candidate.

Selection is application-data replay only: published captures must have both availability and ingestion at or before cutoff. Equality is eligible. A contributing game's confirmed completion bound must be strictly before cutoff, after kickoff and no later than its confirming capture. A `completion-observed-at` bound equals the confirming capture time; an earlier unqualified timestamp cannot backdate it. Scheduled kickoff plus assumed elapsed time never establishes completion. Dated QB membership, raw/canonical game/team consistency and independent offensive-participation evidence are required for player histories. Membership does not establish participation. Unknown target injury/depth stay unknown; explicit exclusion or ambiguous identity withholds.

Revisions carry immutable IDs, predecessors and correction reasons. Selection follows lineage; divergent heads and conflicting event aliases are ambiguous. Equal-time duplicate captures use a deterministic capture-ID tie break. Incomplete captures cannot contribute. Duplicate identical captures are idempotent; changed IDs/bytes, invalid lineage, unknown fields, malformed timestamps and unqualified sources fail closed with fixed errors. Known missing inputs produce unavailable bundles; malformed or tampered datasets are refused before computing a bundle.

The ordered dependency manifest records artifact hashes, raw origins, schema/parser/rights versions, capture/publication times, identity versions and selected correction lineage. Ambiguity includes conflicting dependencies; schedule enumeration and exclusions also retain their source dependencies. The input digest binds cutoff, selected facts, dependencies and transformation version. It excludes only later `computedAt` and the digest itself, so later computation can reproduce the earlier inputs without claiming they were served then.

## Adapter inventory and qualification work

`RAW_ALLOWLISTS` and `validateRawHeader` execute all seven groups of `predictive-raw-allowlist-v1`. Extra columns, duplicate headers and absent required fields are refused. The only registered artifact parser is `synthetic-json-v1`; no CSV acquisition adapter is qualified by these tests. Passing a header allowlist is one check, not permission to treat a current download as historical evidence.

| Feed selected in #49 | Current proof / existing client | Before real capture |
| --- | --- | --- |
| Player statistics: `player_stats_<season>.csv` | Proof uses synthetic paired attempts/yards. Existing `nflverseClient.ts` uses release `stats_player`, asset `stats_player_week_<season>.csv`. | Verify exact release/asset/header, GSIS/game/season grain, missingness and count semantics; register the selected adapter. |
| Team statistics: `team_stats_<season>.csv` | Synthetic own-team and facing-opponent totals | Verify paired game/team identities, exposure definitions, revisions and complete game coverage. |
| Schedules: `games.csv` | Synthetic versioned kickoff/team/game bridges; existing client also reads schedules | Register selected-column filtering, Eastern-time/DST conversion, immutable event bridges and reschedule behavior. A raw scheduled kickoff does not prove completion. |
| Player identifiers: `players.csv` | Synthetic GSIS identity only; other player-ID bridges refused | Register exact aliases/evidence and append-only bridge corrections; report missing/ambiguous matches. |
| Weekly rosters: `roster_weekly_<season>.csv` | Synthetic per-game effective membership. Existing client reads `rosters` / `roster_<season>.csv`. | Qualify the separate weekly-roster adapter and dated membership; do not substitute latest season roster. |
| Injuries and depth | Unknown availability fixture; raw-column allowlists only | Qualify freshness, status/removal semantics, slot/rank identities and publication evidence before raw ingestion or covariate use. |

Completion and participation are open acquisition gates, with this concrete next qualification sequence:

1. Identify a permitted completed-event evidence source and record its rights, exact completion/termination semantics, event IDs and correction behavior. Test suspended/rescheduled/unfinished events. Establish actual-end evidence or the conservative first captured confirmation bound, and keep the latter distinct from physical end time.
2. Enumerate dated market-compatible roster candidates, then evaluate independent offensive-participation evidence. Report confirmed participant, confirmed absent and unresolved counts; include zero-opportunity and special-teams-only cases. ACT/depth rank or positive-usage subsets cannot prove complete population coverage.
3. Evaluate conditional PFR snap evidence and manual official gamebook/box-score reconciliation only under the source decision's rights/bridge gates. Neither is an approved automatic fallback. Preserve unresolved candidates rather than generating zeros or claiming DNP from missing rows.
4. Record exact assets/headers, hashes, first availability/ingestion, bridge versions, parity tests, request/byte/runtime/storage measurements and unresolved coverage in a bounded private qualification report. If no evidence qualifies, report the gap before requesting paid access.

The proof enumerates cutoff-known schedules and per-game membership; target-team games with missing membership remain gaps. It cannot discover an omitted schedule or an unknown former-team game. This conservative fixture policy does not claim complete player history or population coverage. Real dated roster/participation enumeration and all acquisition/rights/public-use gates remain open.

## Next review gate

Owner review of this executable result precedes delivery 2: private content-addressed artifacts, atomic run publication and an additive v3 migration with PostgreSQL A/B replay and constraints. Existing v1/v2 migrations and historical fixtures remain immutable. Readiness minimum stays v2 because app routes do not consume predictive tables; generated maximum-known advances only with the reviewed migration.

Subsequent work includes bounded real-source qualification and the remaining markets/injury/depth feeds. Hosted schema activation remains separately gated by [#95](https://github.com/ven2dev/dfs-ev-demo/issues/95). This increment changes no app route, existing stats sync or remote schema, and does not require repeating the recovery drill.

Validation uses the nested Node Vitest discovery path for the pure replay/CLI cases, then the repository's app and disposable database CI checks. Future persistence tests must join the registered database harness and mandatory report contract; these pure tests create no Postgres tables.

Local validation on 2026-10-08 with Node 24.18.1 passed: typecheck, lint, full app tests, Firestore rules emulator, CI-gate regression, DB target guards, disposable PostgreSQL suite (73 Node cases plus 17 Vitest cases), build, production dependency audit (zero vulnerabilities), local Markdown links and whitespace checks. The full app run passed 831 jsdom and 251 Node cases, including the initial 59 predictive cases. After final contract refinements, all 63 predictive cases, TypeScript and targeted lint passed again. The existing loopback review-server tests needed the app test rerun outside the filesystem/network sandbox; no application code was changed to bypass them.
