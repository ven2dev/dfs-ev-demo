# Local predictive cutoff replay proofs

Deliveries 1 and 2 of [#52's implementation proposal](https://github.com/ven2dev/dfs-ev-demo/issues/52#issuecomment-6054299022) provide executable contracts, a synthetic passing-yards replay, and the same proof backed by private immutable artifacts and disposable PostgreSQL. Delivery 3 now includes a [bounded public-source qualification prototype](predictive-source-prototype.md); real feature publication remains unavailable pending its reported evidence requirements. The [feature contract](predictive-feature-contract.md), [source decision](predictive-data-sources.md) and [operating policy](predictive-data-operations.md) continue to govern subsequent work.

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

### Persistent local proof

Start the pinned disposable service in [the database testing guide](database-testing.md). `test:db:local` starts and removes it automatically for the full suite; the following manual workflow keeps it running for the proof. Supply an existing mode-0700 artifact directory outside the checkout. No API key is needed. Do not export application, Neon or remote database credentials into this shell.

```sh
docker compose --env-file /dev/null --project-name dfs-ev-demo-test -f compose.test.yml up -d --wait
artifact_root=$(mktemp -d "${TMPDIR:-/tmp}/dfs-ev-52-proof.XXXXXX")
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test npm run predictive:local -- demo --artifact-root "$artifact_root"
npm run test:db:down
```

The command accepts only the registered scratch harness and creates, migrates and removes fresh random databases in the disposable service. It refuses the shared primary database as a mutation target, unregistered targets and ambient application credentials. The supplied artifact directory survives database cleanup; keep it private. It contains a registration marker, exact source bytes addressed by SHA-256, and a content-addressed JSON journal of run IDs, capture metadata and artifact references. SQL stores relative content references, never this local directory path.

The report adds `proof: synthetic-postgres-cutoff-replay-v1`, `schemaVersion: 4`, `earlierReplayUnchanged`, `restoredReplayUnchanged`, `archive` and `restored` to the A/B/unavailable scenarios above. It asserts equality between A before and after B, a different B digest, explicit unavailable completion, and exact A restoration into another fresh database. This proves application-data replay; the synthetic timestamps do not claim a historical production acquisition. The earlier saved delivery-2 report used schema version 3.

To restore the journal later, start the same disposable service, retain all referenced source files, and substitute the archive reference and byte count printed by your report:

```sh
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test npm run predictive:local -- restore --artifact-root "$artifact_root" --archive <sha256>.json --archive-bytes <byteSize>
npm run test:db:down
```

Restoration verifies the journal and each referenced file's hash and byte size, republishes through the same validated transaction path and removes its scratch databases. Missing or changed bytes refuse the proof; they are never silently replaced. The journal restores these synthetic runs, not a PostgreSQL backup or a hosted recovery procedure.

## Persistence contract

The additive `0003_predictive_local_replay.sql` migration introduces seven tables. `0004_predictive_team_identity.sql` corrects the Rams identity constraint to accept the application's `nfl:team:LA`, with a database regression checking all 32 IDs against `NFL_TEAM_ABBREVIATIONS`. SQL remains an immutable snapshot; that comparison detects future registry drift. Registered v1/v2/v3 SQL and catalog contracts remain unchanged. The generated schema reference, appended migration manifest, v4 catalog contract and readiness manifest bind the new tip. The application readiness minimum stays **2**; maximum-known is **4**, so a genuine v2 database remains application-ready.

V3 incorrectly allowed `nfl:team:LAR` while application validation only accepted `nfl:team:LA`. V4 validates existing rows when replacing the constraint. An old SQL-created `LAR` row refuses the upgrade and rolls back all DDL/ledger changes; it is not relabelled, deleted or granted an unqualified alias. Tests preserve valid v3 rows and replay results through the upgrade and verify the exact original catalog/history after a refused upgrade.

| Table | Stored truth |
| --- | --- |
| `predictive_ingestion_runs` | Terminal `published`, `incomplete` or `refused` result, request hash, code/adapter versions, timestamps, configured bounds and retained artifact/capture/unique-row counts |
| `predictive_artifacts` | Immutable hash, byte size, relative storage reference and source/parser/schema/rights metadata |
| `predictive_captures` | Run/artifact association, immutable capture/availability/ingestion times and optional source publication evidence |
| `predictive_teams`, `predictive_games` | Stable canonical keys referenced by observations |
| `predictive_observations` | Immutable revision, predecessor and correction reason; exact per-kind JSON data with generated identity columns and foreign keys |
| `predictive_artifact_observations` | Immutable association between exact artifact bytes and validated revisions |

Membership, participation, completion and independent schedule coverage use the validated observation envelope. JSON is checked against exact fields, types, enums, identity and missingness rules for each kind; extra fields are refused. Corrections must share their predecessor's natural key and cannot precede its usable capture or form a cycle. Database triggers refuse UPDATE, DELETE and TRUNCATE on all seven tables. Append-only constraints protect normal SQL operations; catalog verification remains necessary to detect changed triggers or schema.

`ingestLocalDataset` injects the local store rather than fetching a source. Publication validates byte digests, schema and capture envelopes, writes exact bytes durably, then validates lineage against existing published observations inside one transaction. An advisory transaction lock serializes publication and retry checks. Run, capture, identity, revision and artifact associations become visible together at commit. A same-ID/same-request retry reuses its terminal result; an ID conflict rolls back. Files written before a refused SQL publication can remain unreferenced. There is no automatic orphan deletion.

A partially acquired batch records `incomplete` with `partial-acquisition`, quarantines **every** capture and publishes no observations. A refused batch records the fixed `publication-refused` reason and retains only diagnostics whose routing metadata and exact bytes can be validated. Diagnostics never gain observation associations or replay visibility. Failure recording also requires a usable artifact store, database and valid run envelope; the orchestration does not promise a durable failure row when those prerequisites are unavailable. Terminal counts describe retained data, not an estimate of attempted downloads. Run timestamps describe the injected local publication invocation; they are not measured network acquisition durations.

The private artifact store flushes temporary files, installs a new content address exclusively and syncs the directory. It checks the registered root, restrictive permissions, regular-file/link state, size and digest on reads and refuses replacing an existing address. Replay verifies exact stored-byte integrity and equality between parsed source revisions and SQL rows. `safeReplay` returns the fixed `persisted-replay-unavailable` result on storage/integrity/query failure, with no usable summaries or local path leakage.

Replay uses a repeatable-read, read-only transaction. Indexed queries select cutoff-visible natural keys for the target, player's effective membership ranges, scoped team schedules, coverage, aliases and game entities. They then retrieve **all cutoff-visible revisions of each selected key**. A correction moving dates or schedule teams outside an original predicate must still supersede the old revision; selecting only currently matching rows would resurrect it. The natural-key, membership, schedule, entity, alias, capture-routing and reverse-association indexes support these reads. Dependencies and the digest still follow the selected relevant evidence, so unrelated schedule rows do not expand the manifest. This replaces fixture-wide membership selection without claiming a real-roster performance benchmark.

The local bounds are 256 artifacts, 512 captures, 8,000,000 aggregate source bytes and 8,192 observation rows per publication; each artifact is at most 1,000,000 bytes and 2,048 parsed rows. Replay caps returned envelopes at 8,192, including repeated capture provenance and the aggregate query results. Schedule coverage lists at most 256 expected games per team/range; the restore journal permits at most 16 runs and shares the one-file byte limit. SQL operations use a 10-second statement timeout, 3-second lock timeout and 15-second idle transaction timeout. These are synthetic proof limits, not a qualified acquisition/storage retention budget.

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

`RAW_ALLOWLISTS` and `validateRawHeader` execute all seven groups of `predictive-raw-allowlist-v1`. Extra columns, duplicate headers and absent required fields are refused. The only registered **SQL publication** artifact parser remains `synthetic-json-v1`. The separate [source prototype](predictive-source-prototype.md) registers exact full CSV header profiles, projects the allowlist and stores research bases outside SQL; it does not qualify replay observations. Passing a header allowlist is one check, not permission to treat a current download as historical evidence.

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

Owner decision on 2026-10-09 after branch review: **option B — hold delivery 2 off main until the real-source schema is designed**. Delivery 2's synthetic-only schema and delivery 3's source qualification remain WIP on the feature branch. Delivery 1 is complete; the current combined branch is not a merge-ready delivery-1/2 PR. The registered proof migrations are retained on the WIP branch under the repository's immutable-history checks; this decision does not approve them as the final product schema.

The next merge gate is a reviewed real-source schema and an appropriate final PR scope. Review should still cover delivery 2's typed payload/lineage/immutability constraints, atomic publication and retry behavior, quarantine of partial/refused diagnostics, exact-byte verification, correction closure in scoped reads, restoration into a fresh scratch database and the v4 identity correction. The **14** mandatory predictive database cases join the existing lease/readiness report gates; missing, filtered, skipped, todo or failed cases cannot produce a passing DB run. Pure replay/storage/source cases remain in the Node Vitest suite.

The [test reasoning review](predictive-test-review.md) maps each new case to its contract and evidence, records the strengthened failure checks and isolated fault-injection results, and explains the limits of the synthetic proof.

Delivery 3 must qualify the source adapters and evidence described above, measure request/byte/runtime/storage cost under a reviewed acquisition budget, and report missing completion, participation and membership enumeration before expanding capture. Synthetic passing tests do not qualify a real source, its rights, historical coverage or model population. Remaining markets/injury/depth feeds follow their own contracts. Scheduled rest remains the raw kickoff interval, including offseason gaps; flagging or capping belongs to #54's reviewed modeling transformations.

Hosted schema activation remains separately gated by [#95](https://github.com/ven2dev/dfs-ev-demo/issues/95). This increment supplies a local additive migration and changes no app route, existing stats sync or remote schema. Do not run Production `up` as part of either proof.

## Delivery 2 validation

On 2026-10-09, Node 24.18.1 validation passed typecheck, lint, all 831 jsdom + 302 Node tests (including 110 pure predictive/storage cases), the disposable PostgreSQL suite (74 mandatory Node + 29 Vitest tests, including all 12 predictive cases), catalog/artifact drift checks, Firestore rules, the CI gate, DB target/report guards and the production build. The production dependency audit reported zero vulnerabilities. Historical v1/v2 files/contracts, local Markdown links and whitespace were checked. These are local results; hosted CI still runs when a PR is opened.

The saved local proof has 47 dependencies and input digest `68165324afe28b6cd202446af4261fae3cb9b2f8eabd9c9af3ac176a3fb1ff62` for initial A, A after B and restored A. Later B changes the digest to `b7aee90b12c3bd175718674be6270e3a070a8b7fa8c4bcc9495bb76f894069ef`. The subsequent unresolved-completion correction produces `unavailable-inputs`. The restore journal is `8b2db24ec36dbdc035930e07d2845e7186d1b3053ab303825d18cafc827c0e7f.json`, 6,524 bytes; its referenced private files must be retained for restoration.

The later Rams-review regression first failed against v3's `predictive_teams_id_check`. After v4, the complete disposable database run passed 74 mandatory Node + 31 Vitest tests, including all 14 predictive cases, all-team SQL parity, Rams publication/replay, valid v3 upgrades and rollback for legacy `LAR`. Typecheck, lint, all 831 jsdom + 374 Node tests and the production build passed. The source qualification capture was not repeated for this schema fix.
