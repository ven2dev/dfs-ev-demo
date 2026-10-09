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

The feature version `passing-yards-replay-v2` includes the branch-review fixes below and defines these transformations. This feature version is independent of the database migration version:

| Output | Inputs / transformation | Unit |
| --- | --- | --- |
| `attemptsSum`, `attemptsPerGame` | Explicit per-game attempts, summed; divide by observed game count for volume | attempts; attempts/game |
| `passingYardsSum`, `passingYardsPerAttempt` | Paired explicit per-game yards/attempts; sum yards divided by sum attempts | yards; yards/attempt |
| `team` summaries | Target team's own eligible prior game totals | Same units; separate denominators |
| `opponent` summaries | Other offenses facing the target opponent in eligible prior games | Same units; separate denominators |
| `scheduledRestHours` | Target-team scheduled kickoff pair divided by 3,600,000 milliseconds; preceding game crosses REG/POST boundaries | hours; diagnostic enrichment |

Every group has last-4/8/16 windows within the target's REG or POST sequence and current/prior-two season range. Summaries retain expected slot IDs, observed per-game values, date ranges, numerator/denominator sums, excluded counts and reasons. `unknownGames` is the subset of excluded slots with unresolved/missing required evidence. Short history is visible and model sufficiency remains #54's decision. A missing newest game's statistics stay in its slot; the window does not reach farther back to replace it. Zero counts and signed integer yards remain observed values; blank fields stay null. Zero pooled exposure has no efficiency ratio and withholds a required candidate.

Owner decision on 2026-10-08: confirmed absence consumes its chronological slot and adds `player-known-absences`, while usable observed history remains eligible. The absent game contributes no numeric value or denominator, and is never converted into zero or replaced with an older game. `attemptsPerGame` divides by observed participant games. Unknown participation, completion or identity still withholds; an all-absent required window withholds for its unavailable denominator. This is feature-input eligibility, not #54 model sufficiency or a change to label/participation conditioning.

Selection is application-data replay only: published captures must have both availability and ingestion at or before cutoff. Equality is eligible. A contributing game's confirmed completion bound must be strictly before cutoff, after kickoff and no later than its confirming capture. A `completion-observed-at` bound equals the confirming capture time; an earlier unqualified timestamp cannot backdate it. Scheduled kickoff plus assumed elapsed time never establishes completion. Dated QB membership, raw/canonical game/team consistency and independent offensive-participation evidence are required for player histories. Membership does not establish participation. Unknown target injury/depth stay unknown; explicit exclusion or ambiguous identity withholds.

Revisions carry immutable IDs, predecessors and correction reasons. Selection follows lineage; divergent heads and conflicting event aliases are ambiguous. Equal-time duplicate captures use a deterministic capture-ID tie break. Incomplete captures cannot contribute. `validateDataset` validates the complete candidate ingestion/publication dataset, including byte integrity, schema, IDs and correction lineage. Replay first selects published captures whose availability and ingestion bounds are cutoff-known, then validates only their referenced artifacts and lineage. Later bad payloads, ID conflicts or corrections, unreferenced artifacts and incomplete diagnostic captures cannot poison earlier replays. A malformed routing envelope whose cutoff visibility cannot be established is refused. Visible corrupted bytes still fail closed; this does not waive ingestion validation or permit modifying immutable old artifacts. Replay limits apply to the visible dataset, not later appended records.

The ordered dependency manifest records artifact hashes, raw origins, schema/parser/rights versions, capture/publication times, identity versions and selected correction lineage. Schedule dependencies are the target, the actual player/team/opponent window games, the preceding rest game, and relevant intervening or conflicting evidence, plus the scoped coverage manifests and dated membership evidence that establish required former-team scopes. `excludedSchedule` contains the target and relevant intervening games; each history summary owns its slot exclusions. Unrelated league games, their corrections and their identity ambiguities change neither manifest, exclusions nor digest. Artifact hashes continue to bind exact immutable source bytes; recapturing unchanged immutable revisions keeps their earliest usable provenance. The input digest binds cutoff, selected facts, dependencies and transformation version. It excludes only later `computedAt` and the digest itself, so later computation can reproduce the earlier inputs without claiming they were served then.

### Required schedule enumeration evidence

`schedule-coverage` is a separate versioned evidence kind, keyed by team and the exact current/prior-two season range. It declares the complete expected canonical game-ID set for both REG and POST, a complete/incomplete state and an evidence version. The proof needs cutoff-eligible coverage for the target team, enriched opponent and known former player teams. Coverage is declared independently of the rows remaining in an artifact; the replay never derives completeness from consecutive week numbers, positive statistics, or the number of downloaded rows.

Missing, ambiguous, incomplete or late coverage yields `unavailable-inputs`. A missing declared schedule row is reported in `scheduleCoverage.missingGameIds`; summaries and rest stay unavailable because the correct chronology cannot be established. Removing the entire game and all of its other records still leaves this detectable gap. A known team game omitted from coverage, or a covered game mapped to a different team/range, is also unavailable. Byes are accepted when the explicit expected set is complete. Real acquisition must qualify independent enumeration and full capture completeness; the synthetic manifests do not establish real coverage.

Rest uses the immediately preceding target-team event before target kickoff within the covered seasons, regardless of season type. That event must already be confirmed complete by cutoff; it cannot be skipped for an older game. A known game at or after cutoff and before target for the target team/player, or enriched opponent, withholds the requested bundle and records `intervening-*-game`. Future player participation remains unknown. Rest becomes available only after the immediately preceding game and its required evidence are cutoff-eligible. Tied preceding game times are ambiguous rather than resolved by UUID.

## Adapter inventory and qualification work

`RAW_ALLOWLISTS` and `validateRawHeader` execute all seven groups of `predictive-raw-allowlist-v1`. Extra columns, duplicate headers and absent required fields are refused. The only registered artifact parser is `synthetic-json-v1`; no CSV acquisition adapter is qualified by these tests. Passing a header allowlist is one check, not permission to treat a current download as historical evidence.

| Feed selected in #49 | Current proof / existing client | Before real capture |
| --- | --- | --- |
| Player statistics: `player_stats_<season>.csv` | Proof uses synthetic paired attempts/yards. Existing `nflverseClient.ts` uses release `stats_player`, asset `stats_player_week_<season>.csv`. | Verify exact release/asset/header, GSIS/game/season grain, missingness and count semantics; register the selected adapter. |
| Team statistics: `team_stats_<season>.csv` | Synthetic own-team and facing-opponent totals | Verify paired game/team identities, exposure definitions, revisions and complete game coverage. |
| Schedules: `games.csv` | Synthetic versioned kickoff/team/game bridges and independent scoped coverage manifests; existing client also reads schedules | Register selected-column filtering, Eastern-time/DST conversion, immutable event bridges, reschedule behavior and independent full enumeration/capture evidence. A raw scheduled kickoff does not prove completion or completeness. |
| Player identifiers: `players.csv` | Synthetic GSIS identity only; other player-ID bridges refused | Register exact aliases/evidence and append-only bridge corrections; report missing/ambiguous matches. |
| Weekly rosters: `roster_weekly_<season>.csv` | Synthetic per-game effective membership. Existing client reads `rosters` / `roster_<season>.csv`. | Qualify the separate weekly-roster adapter and dated membership; do not substitute latest season roster. |
| Injuries and depth | Unknown availability fixture; raw-column allowlists only | Qualify freshness, status/removal semantics, slot/rank identities and publication evidence before raw ingestion or covariate use. |

Completion and participation are open acquisition gates, with this concrete next qualification sequence:

1. Identify a permitted completed-event evidence source and record its rights, exact completion/termination semantics, event IDs and correction behavior. Test suspended/rescheduled/unfinished events. Establish actual-end evidence or the conservative first captured confirmation bound, and keep the latter distinct from physical end time.
2. Enumerate dated market-compatible roster candidates, then evaluate independent offensive-participation evidence. Report confirmed participant, confirmed absent and unresolved counts; include zero-opportunity and special-teams-only cases. ACT/depth rank or positive-usage subsets cannot prove complete population coverage.
3. Evaluate conditional PFR snap evidence and manual official gamebook/box-score reconciliation only under the source decision's rights/bridge gates. Neither is an approved automatic fallback. Preserve unresolved candidates rather than generating zeros or claiming DNP from missing rows.
4. Record exact assets/headers, hashes, first availability/ingestion, bridge versions, parity tests, request/byte/runtime/storage measurements and unresolved coverage in a bounded private qualification report. If no evidence qualifies, report the gap before requesting paid access.

The proof requires complete scoped schedule evidence and detects omitted expected games. Target-team games with missing membership remain gaps. An entirely unknown former team still needs a qualified dated player-membership inventory; team schedule coverage does not establish complete player/population coverage. Real roster/participation enumeration and all acquisition/rights/public-use gates remain open.

For a known former team, cutoff-known QB membership ranges also establish expected history slots: a team game with kickoff at or after `effectiveFrom` and strictly before `effectiveTo` remains in the window even when its own membership row is missing. The slot reports `membership-missing` and withholds the bundle. A range never substitutes for per-game membership, participation or numeric evidence. Selected corrections control the range at each cutoff; conflicting heads remain unavailable. Dependencies retain the membership and schedule evidence that established a retained gap. Games outside the range stay outside player history unless independently included by per-game evidence or the current-team gap rule.

## Next review gate

Owner review of this executable result precedes delivery 2: private content-addressed artifacts, atomic run publication and an additive v3 migration with PostgreSQL A/B replay and constraints. Persistence must retain immutable cutoff-routing metadata, quarantine failed diagnostic captures, validate candidate publication before exposing rows, retain independently versioned coverage manifests, and store only scoped dependency closures. Existing v1/v2 migrations and historical fixtures remain immutable. Readiness minimum stays v2 because app routes do not consume predictive tables; generated maximum-known advances only with the reviewed migration.

Delivery 2 must replace fixture-wide membership selection with indexed queries bounded by player, team and effective date ranges before real-source qualification. Scheduled rest remains the raw kickoff interval, including offseason gaps; any flagging or capping belongs to #54's reviewed modeling transformations.

Subsequent work includes bounded real-source qualification and the remaining markets/injury/depth feeds. Hosted schema activation remains separately gated by [#95](https://github.com/ven2dev/dfs-ev-demo/issues/95). This increment changes no app route, existing stats sync or remote schema, and does not require repeating the recovery drill.

Validation uses the nested Node Vitest discovery path for the pure replay/CLI cases, then the repository's app and disposable database CI checks. Future persistence tests must join the registered database harness and mandatory report contract; these pure tests create no Postgres tables.

Initial WIP validation on 2026-10-08 with Node 24.18.1 passed: typecheck, lint, full app tests, Firestore rules emulator, CI-gate regression, DB target guards, disposable PostgreSQL suite (73 Node cases plus 17 Vitest cases), build, production dependency audit (zero vulnerabilities), local Markdown links and whitespace checks. The full app run passed 831 jsdom and 251 Node cases, including the initial 59 predictive cases. After initial contract refinements, all 63 predictive cases, TypeScript and targeted lint passed again. The existing loopback review-server tests needed the app test rerun outside the filesystem/network sandbox; no application code was changed to bypass them.

Branch-review follow-up on 2026-10-08 passed all 94 predictive cases, typecheck, lint, the full app suite (831 jsdom + 286 Node cases), Firestore rules, CI gate, DB guards and disposable PostgreSQL suite (73 + 17 cases), build, production audit (zero vulnerabilities) and local links/whitespace. The reviewer's original reproduction scenarios were rerun against the updated modules: earlier A survives later bad corrections/schema, unrelated schedule dependencies stay 47 → 47 with the same digest, POST rest is 168 hours, intervening/missing schedules withhold, and a confirmed oldest absence stays usable. Named-arrow functions are used throughout the predictive modules and fixtures/tests. Persistence remains the next reviewed delivery.

Re-review follow-up on 2026-10-09 retained the owner's confirmed-absence decision, reproduced and fixed the known former-team membership gap, and merged `origin/main` at `33f537e`. The 105 predictive cases include both candidates, effective-date boundaries, unresolved per-game participation, conflicting membership heads and cutoff isolation for late ingestion/corrections. With the merged dependencies installed, typecheck, lint, all 831 jsdom + 297 Node cases, Firestore rules, CI gate, DB guards, disposable PostgreSQL (73 + 17 cases), build and production audit (zero vulnerabilities) passed. The local synthetic A/B proof and whitespace checks also passed. This follow-up changes no persistence schema.
