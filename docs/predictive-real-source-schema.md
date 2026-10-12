# #52 real-source schema proposal — revision 2

Status: **revision 2 approved by the owner (2026-10-09), including the snap-share
amendment, and implemented in PR A** on `feature/dfsEV-52-evidence-schema`
(2026-10-10). The column-level DDL, with per-step and per-review-fix notes, is in
[`predictive-evidence-ddl.md`](predictive-evidence-ddl.md). Revision 2 incorporates the
2026-10-09 design review. It continues from the relay handoff
(`docs/predictive-session-handoff.md`, `1ef86ba`) on
`feature/dfsEV-52-predictive-cutoff-replay`. PR A merged in
[PR #102](https://github.com/ven2dev/dfs-ev-demo/pull/102); migration 0003 is
frozen. [PR B](predictive-pr-b.md) now owns actual-source qualification,
raw CSV publication and measured cutoff replay.

## 0. Decisions and scope

Owner decisions (2026-10-09):

1. The final PR ships **one reviewed real-source v3**. The branch's synthetic
   v3/v4 stay as branch history only (section 9 covers the reset rules and the
   open confirmation).
2. The schema is designed for **all nine registry markets**. Passing yards stays
   the first end-to-end vertical slice.
3. The target is **local, hosted-ready**. #95 still gates any hosted use.
4. **Snap share is a required enrichment** for the enriched RB/FB/WR/TE rushing
   and receiving candidates (contract amendment in section 7).
5. The forks are settled per the review: F1 JSONB payload with typed routing; F2
   coverage-aware absence that blocks a required input; F3 positive usage as
   individual evidence only; F4 reject PFR; F5 two PRs; F6 qualify SportsDataIO.

Unchanged rules: an approved absence keeps its window slot; readiness minimum
stays v2; no Production `up`, hosted jobs, keys or purchases; synthetic
constraints are not loosened to admit real data.

## 1. Principles

- **Bytes, evidence and labels are separate layers.** Exact raw bytes live in the
  private content-addressed store. Postgres holds the allowlisted projection with
  provenance (*evidence*). Canonical outcome *labels* are derived, separately
  versioned decisions. Excluded columns never become SQL rows.
- **Source truth vs canonical selection.** Each provider's claims are kept as that
  provider's revisions. Which claim counts is decided by a versioned
  reconciliation policy, recorded as its own decision, never by one provider
  "correcting" another.
- **Append-only application writes; controlled retention.** The ingest/replay path
  never updates or deletes. Retention operations are a separate, audited mechanism
  (section 8).
- **Unknown stays unknown.** No default, missing row or elapsed time becomes zero,
  DNP, healthy, completed or final.
- **Every dependency is cutoff-checked**, not only the numeric value.

## 2. Keys

Every evidence row carries two keys, both stored as typed columns:

- **Entity key**: kind + canonical game + player/team + applicable context (for
  example the stat family, or the season range for coverage). It answers "what
  is this fact about?"
- **Source revision key**: entity key + source profile + source record
  discriminator (the provider's own row identity where one entity can have several
  provider rows). It answers "which provider's claim is this?"

Rules:

- `predecessor_id` must share the **source revision key**. A correction never
  crosses providers or profiles. That's enforced by a composite foreign key, as v3
  already does for `(id, kind, natural_key)`.
- Branching heads within one source revision key remain `ambiguous`.
- Selecting across sources is done only by a reconciliation decision (section 4.5).

## 3. Registration, rights and runs

### 3.1 Immutable profiles

`predictive_source_profiles`: provider, feed, release tag, asset pattern, exact
header profile, parser version, selected-column allowlist version, license and
attribution text. Immutable; a change is a new profile. No status column.

### 3.2 Rights decisions (appended, effective-dated)

`predictive_rights_decisions`: profile, decision ID, allowed uses
(`adapter-testing`, `internal-research`, `model-input`, `outcome-label`,
`public-display`), `effective_from` / `effective_to` (nullable), evidence (terms
URL, retrieval date, written confirmation reference), and a predecessor decision.
A revocation is a new decision with no allowed uses.

- **Run-time audit:** each ingestion run records the rights decision IDs it relied
  on. That preserves what was authorized then.
- **Read-time enforcement:** feature and label reads join the decision effective
  *now* for the requested use. A later revocation blocks current use without
  rewriting history.
- Trial data (for example SportsDataIO scrambled data) gets only
  `adapter-testing`, so it can never feed features or labels.

### 3.3 Blobs vs artifacts

- `predictive_blobs`: sha256, byte size, storage reference. Identity is the bytes
  only.
- `predictive_artifacts`: blob + source profile + retrieval context (origin URL,
  provider etag/last-modified, release `updated_at` as diagnostic only,
  `full` / `header-probe`, request scope such as season/week/filter).
- Identical bytes from two retrievals share one blob, with two artifact records.

### 3.4 Runs and captures

`predictive_ingestion_runs` as in the proof, plus profile IDs, rights decision
IDs, validated budget, measured metrics (requests, consumed bytes, rows, peak
RSS) and a **declared capture scope** (section 5). `predictive_captures` are
unchanged: `captured_at` after the full body; `available_at` is the capture time
unless publication is verified; `ingested_at` after the durable write.

## 4. Evidence and decisions

### 4.1 Identity

32 seeded `teams` (`nfl:team:LA` for the Rams) + `team_alias_revisions`;
minted `games` + `game_bridge_revisions` + `game_relations`
(replacement → predecessor; reschedule keeps the UUID); `player_bridge_revisions`
(GSIS ↔ provider IDs, for example SportsDataIO `PlayerID` via a qualified bridge).
All are effective-dated, evidence-linked and source-revisioned. Overlapping active
mappings resolve as `unresolved`.

### 4.2 Evidence kinds

`predictive_observations` keeps the proven envelope: typed routing columns
(kind, entity key, source revision key, game, player, team, season, season type,
profile, artifact link) under SQL constraints, plus a strict per-kind JSONB
payload.

| Kind | Entity key | Payload |
| --- | --- | --- |
| `schedule` | game | raw game ID, season/type/week, raw `gameday` + `gametime` + `America/New_York`, derived kickoff UTC, home/away + raw aliases, raw venue/roof |
| `schedule-coverage` | team × season range | enumerated game UUIDs, state |
| `membership` | game × player | team, raw team, position, weekly status code, season/week/type |
| `player-game-stats` | game × player | ten count fields, each nullable with its own missing reason |
| `team-game-stats` | game × team | the same ten fields |
| `player-game-snaps` | game × player | `offense_snaps`, `special_teams_snaps`, provider `played` / `started` flags; optional `routes_run`; each nullable with a reason |
| `team-game-snaps` | game × team | `offense_snaps` (plus optional `dropbacks`), with the provider's play-counting definition ID |
| `event-state-marker` | game | marker type (section 4.3), marker value, raw evidence reference |
| `participation-evidence` | game × player | evidence kind (`positive-usage`, `participation-feed`, `provider-snap-count`, `official-inactive-list`), claim (`offensive-participant`, `zero-offensive-participation`, `inactive-or-dnp`) |
| `availability` | game × player | raw injury report category/text/cycle, raw depth slot/rank |
| `source-row-absent` | as the absent row | prior observation ID, covering capture ID, coverage proof (section 5) |

Validators: non-negative integer counts, signed integer yards,
`completions ≤ attempts`, `receptions ≤ targets`, `offense_snaps ≤ team
offense_snaps` (same provider), no zero-filling of blanks.

### 4.3 Completion

Completion is a **decision**, not an appearance.

- Accepted markers, each registered per profile: a qualified provider final-status
  marker (for example a schedule/status field documented as final), a
  terminal-play marker in play-by-play (`END GAME`), and final team totals present
  with provider final status. A file that merely contains the game is **not** a
  marker; live and partial games appear in files.
- `predictive_completion_decisions` (policy `event-completion-v1`): game, state
  (`scheduled`, `in-progress`, `completed`, `suspended`, `postponed`, `canceled`,
  `conflicting`), the marker observation IDs used, `completion_observed_at` (the
  first capture of a **qualified completion marker**, never first appearance), and
  `actual_end` + its qualification. A final PBP `time_of_day` is an `actual_end`
  candidate only after completion is established, and only after midnight-UTC
  rollover, overtime and missing-row checks.
- Conflicts (for example final status but no terminal play, or markers from two
  sources disagreeing) give `conflicting`, which withholds. Suspended games stay
  `suspended` until a terminal decision; partial totals never become final.

### 4.4 Participation

`predictive_participation_decisions` (policy `participation-v1`): game × player →
`offensive-participant` / `zero-offensive-participation` / `inactive-or-dnp` /
`unresolved`, with the evidence observation IDs. Positive usage, or a provider
offensive snap count of at least 1, supports `offensive-participant` for that
**individual label**. Neither establishes a complete population. The ledger
reports covered, excluded and unresolved counts per scope.

### 4.5 Reconciliation (cross-source selection)

`predictive_reconciliation_decisions` (policy ID + version): an entity key →
selected source revision **or** `conflict` / `insufficient-sources`, with all
candidate revision IDs and the rule applied (for example "single qualified
source", "sources agree", "authority order X", "material discrepancy"). Earlier
decisions stay, and a new policy version adds new decisions. Features and labels
read reconciled evidence; raw provider revisions remain inspectable.

### 4.6 Outcome labels

`predictive_outcome_labels` (policy `canonical-label-finalization-v1`, carried in
full from the feature contract): player × game × season type × stat; value or
null; state `provisional` / `final` / `unresolved` / `excluded`.

- Stored per label: `eligible_final_at`, **the later of** completion bound + 72h
  and the first Thursday 12:00 UTC after it; `finalized_at` (the actual decision
  time); the post-window successful capture ID; the completion, participation,
  reconciliation and identity decision IDs; label version and predecessor.
- `final` requires the post-window capture, confirmed completion, an explicit
  applicable statistic, resolved identity and participation, no material
  discrepancy, and a qualified reconciliation. Elapsed time alone never finalizes.
- Later corrections add new versions. Evaluations keep the version they used.

## 5. Disappearance (coverage-aware)

- Each capture declares its **scope** (profile, season, week/filter, full-file or
  partial) and its **completeness** (full body read, header verified, parser
  success, row count within expected bounds).
- A `source-row-absent` observation is created only when a later capture is
  complete **and** its scope covers the prior row's scope. A partial download,
  changed filter, header probe or parser failure cannot establish absence; those
  produce run diagnostics instead.
- Interpretation by cutoff: before the absence is available, the prior head is
  used as before. After it, an explicit missingness policy (`absence-policy-v1`)
  applies, and for a **required** input that means **blocking** feature
  construction for that entity (`required-input-disappeared`) until a later
  revision or reconciliation resolves it. The evidence is preserved, not made
  unusable for history.

## 6. Replay dependencies

Each feature bundle records a dependency manifest naming the exact:

- observation revisions (stats, snaps, schedule, membership, availability);
- identity bridge revisions (team, game, player);
- completion, participation and reconciliation decisions, plus the policy versions
  applied (absence, reconciliation, completion, participation);
- feature-definition version, rights decision IDs, and code/transform version.

Every listed dependency must be available, and ingested, at or before the cutoff.
The digest covers the full manifest.

**Ratios:** numerator and denominator come from the same game set and the same
provider (or from a recorded compatibility decision). A zero or missing
denominator leaves the ratio undefined and withholds when it's required.
**Provider switching** for snaps needs a `snap-source-compatibility` decision
(definition parity, overlap-sample comparison, identity coverage) before mixing or
replacing providers within a window.

## 7. Snap-share contract amendment (proposed for #49)

- `prior_snap_share` = Σ player `offense_snaps` / Σ team `offense_snaps` over the
  same eligible games and provider. A pooled fraction.
- `prior_targets_per_snap` = Σ `targets` / Σ `offense_snaps` on paired records.
- `prior_targets_per_route` and `prior_route_share` are defined, but optional,
  only with a qualified routes source.
- Required for enriched `player-opponent` rushing/receiving candidates; the
  `stats-v1` candidates are unchanged. Without a qualified source the result is
  `unavailable-inputs` / `snap-share-source-unqualified`. Target and carry share
  keep their own names and are never relabelled.

Source status (research 2026-10-09; no accounts, keys or purchases):

| Source | Finding | Status |
| --- | --- | --- |
| PFR / nflverse `snap_counts` | Data-use policy restricts use supporting ML that predicts | Rejected, absent separate permission |
| nflverse participation (FTN) | Per-play on-field lists, delivered after the postseason | Historical training only, after the share-alike review |
| SportsDataIO `PlayerGame` | `OffensiveSnapsPlayed`, `OffensiveTeamSnaps`, `SpecialTeamsSnapsPlayed`, `Played`, `Started`; since 2012; available the morning after | **Qualify.** Licences "can cover" model input and derived display, but that is contract-specific. Discovery Lab ($99/mo, $599/yr) is personal and non-commercial; the commercial tier is by quote. |
| SportsDataIO free trial | Scrambled values; "cannot be used for analysis or display" | `adapter-testing` rights only |
| MySportsFeeds, BallDontLie, FTN Data, Fantasy Points Data, NFL gamebooks | No confirmed in-season snap field, or cost/rights unsuitable, or manual only | Not pursued now |

Owner questions for SportsDataIO, before any purchase: (1) Is an internal pilot
for a product in development personal use, or does it need a commercial licence?
(2) What does a commercial licence cost for model input plus derived display?
(3) Does `Played` mean at least one *offensive* snap? Also: the `fantasy_data_id`
↔ `gsis_id` bridge in nflverse `ff_playerids` needs its own rights and coverage
check.

## 7b. Additional candidate features (owner-approved 2026-10-10)

These are added to the #49 feature contract as **candidate enrichments**. Each one
needs its source gate to pass, and #54 decides by walk-forward evaluation whether
it earns a place in a model. None is a hidden dependency of the `stats-v1`
candidates, and none is weighted by hand.

| Feature ID (proposed) | Definition | Source and gate |
| --- | --- | --- |
| `prior_carries_per_snap` | Σ carries / Σ offense snaps, paired | Snap source (section 7) |
| `prior_usage_by_game_script` | Targets, carries and attempts per snap/play split into leading by 8+, within 7, trailing by 8+ (thresholds are versioned) | nflverse play-by-play score/clock (CC BY 4.0); aggregation-parity check vs weekly stats |
| `depth_role` | Starter / 2nd / 3rd+ at the cutoff, from depth-chart rank, with recent snap share as a cross-check | nflverse depth charts; slot/identity/freshness gate. A 59.7 MB file needs its own memory and acquisition budget |
| `vacated_opportunity` | For teammates with a qualified OUT/inactive status at the cutoff: their prior target and carry share, plus this player's share in past games without them | Teammate injury status (report-cycle semantics gate), game-level participation, snap source |
| `qb_change` | The target-game QB differs from the QB in the player's prior games (receivers) | Depth chart + injury status + participation |
| `forecast_conditions` | Temperature (hot/cold bands from °C), wind m/s, precipitation amount, and precipitation type (rain/snow, from the provider's type or temperature + precipitation) | Forecast-history source gate (unchanged); roof/closure check |
| `venue_context` | Roof type and closure state, surface (grass/turf), altitude, home/away/neutral, stadium ID | nflverse schedule `roof`/`surface`/`stadium_id` captured raw, needing an earlier-version check; an altitude table is a registered static profile |
| `home_field_proxy` | Home/away plus a stadium identifier. Crowd noise has no direct measure; this is the tested proxy | Schedule + venue gates |
| `defense_scheme_context` | **Reserved slot**: player usage vs man/zone/blitz rates of the opponent | **Unavailable / `source-unqualified`.** No affordable in-season source. A paid charting source (FTN, PFF) is to be priced later. Always returns unavailable until then. |

**Correction (review, 2026-10-10):** these features are **reserved**, not ready.
Snap, depth, injury, schedule-venue and roster evidence fit the v3 kinds, but
play-by-play game-script aggregates, forecasts, surface and altitude have no
evidence kind in v3. Their evidence contracts are deferred, and adding them will
need a later additive migration after 0003 is frozen. Until then a feature
whose source or evidence contract is missing yields `unavailable-inputs` /
`<feature>-source-unqualified` for the candidates that require it.

## 8. Retention and size

**Retention** (`retention-policy-v1`, owner-run, outside the append-only write path):

- **Superseded by the owner decision of 2026-10-10:** a provider-required removal
  **deletes** the blob bytes and every derived row (observations and their chain
  descendants, decisions, labels, saved feature runs), scoped to the affected
  provider or dataset, and keeps a minimal audit record where permitted. Replays
  that needed removed evidence return `unavailable` / `retained-evidence-removed`.
  Full mechanics are in the DDL draft, section 9.
- Backups re-apply later deletions by their deterministic scope descriptor. If a
  provider forbids even that, the affected backups are destroyed.
- The DB triggers keep blocking ordinary UPDATE/DELETE. Retention runs only
  through the owner-only function, never through ingest or replay.

**Sizes (restated with units; to measure in PR B):**

| Item | Observed (2026-10-09 capture) |
| --- | --- |
| Player-week stats file, 2026 season to date | 2,011,144 bytes, 4,517 rows |
| All 7 raw files in that capture (depth = 4 KB probe) | 15,946,114 bytes |
| Plus release metadata | 2,111,509 bytes (18,057,623 consumed) |
| Peak process RSS | ~463 MiB |

PR B measures, separately: rows per kind per capture, capture-link rows, index
bytes, raw blob growth per day under content addressing, and peak RSS under a
streaming parse.

## 9. Migration and branch plan

Historical reset procedure below was completed in PR A before merge. Migration
0003 is now released; any further schema extension requires a forward migration.

1. **Disposable-only history:** Codex confirmed (2026-10-09, from its saved
   execution history and the test harness) that v3/v4 ran only in temporary local
   Docker test databases that were dropped afterwards. Its earlier `db:migrate:dev`
   calls used the disposable target and predate v3/v4. Nothing ran on persistent
   dev, Neon or Production. The owner confirmed (2026-10-09) that they ran no
   migration against a non-disposable database from this branch. The branch isn't
   on main. **The reset is cleared.**
2. If that's confirmed, replace `0003`/`0004` with one `0003_predictive_evidence.sql`
   in a normal forward commit, and regenerate the manifest, catalog contract,
   schema reference and readiness manifest. **Document the reset** in
   `docs/database-migrations.md`. Any local database that has the old v3/v4 must be
   recreated. The migration runner is **not** changed to accept edited checksums.
3. Readiness minimum stays at 2; maximum-known is 3.

## 10. Delivery sequence

1. **Semantics:** approve this revision and the snap-share amendment, then the
   column-level DDL review.
2. **PR A** (deliveries 1+2 + real v3): real-schema fixtures and tests for source
   conflict, cross-source correction refusal, coverage-aware disappearance,
   completion markers/conflicts/suspension, rights decisions (grant, revoke,
   read-time block), dependency-manifest cutoffs, retention operations and label
   finalization gates, plus the existing synthetic cases.
3. **PR B** (passing-yards vertical slice on real nflverse data): measure
   correctness, memory and capture costs.
4. **Then:** qualify snaps (SportsDataIO, licence-dependent) and participation
   coverage before expanding the enriched rushing/receiving evaluation.

**Main risk:** model readiness, not DB capacity. Excluding unresolved
zero-opportunity participants can bias distributions upward. "Acceptable for QB
starters" is an **exploratory scope statement** until coverage is measured.

Sources:
[nflverse data schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html),
[nflreadr PBP dictionary](https://github.com/nflverse/nflreadr/blob/main/data-raw/dictionary_pbp.csv),
[participation dictionary](https://github.com/nflverse/nflreadr/blob/main/data-raw/dictionary_participation.csv),
[roster status dictionary](https://github.com/nflverse/nflreadr/blob/main/data-raw/dictionary_roster_status.csv),
[Sports Reference data use](https://www.sports-reference.com/data_use.html),
[SportsDataIO developers](https://sportsdata.io/developers),
[SportsDataIO NFL data dictionary](https://sportsdata.io/developers/data-dictionary/nfl),
[SportsDataIO data rights FAQ](https://sportsdata.io/help/data-rights-and-licensing-questions),
[nflverse ff_playerids dictionary](https://github.com/nflverse/nflreadr/blob/main/data-raw/dictionary_ff_playerids.csv).
