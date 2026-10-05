# Predictive feature, identity and outcome contract

Decision date: 2026-10-05. This is Step 2 of
[issue #49](https://github.com/ven2dev/dfs-ev-demo/issues/49), following the
[source qualification](predictive-data-sources.md) and
[approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/49#issuecomment-6002308058).
It defines candidate inputs for #52 and evaluation requirements for #54.
It does not implement ingestion, migrations, a model, or a runtime fallback.

## Capability boundary and current implementation

The exact nine markets and their stat/position mappings come from
[`PLAYER_PROP_MARKETS`](../src/lib/playerPropMarkets.ts). Scorer Yes-only
markets remain outside this contract. Passing markets use QB identities;
rushing markets allow QB/RB/FB/WR/TE; receiving markets allow RB/FB/WR/TE.
Do not narrow RB to exclude FB or broaden the registry through a data join.

[`playerStatsSync.ts`](../src/lib/playerStatsSync.ts) already maps the nine
outcome fields. The current [`schema.sql`](../db/schema.sql) and
[`playerStatsRepo.ts`](../src/lib/playerStatsRepo.ts) upsert corrections in place;
their uniqueness key lacks game identity and season type. The current
[`playerCrosswalk.ts`](../src/lib/playerCrosswalk.ts) caches provider names and
uses the latest roster on a cache miss. These are current application behaviors,
not evidence that the future cutoff, historical membership or label contract is
implemented. #60 supplies migration delivery before #52 adds persistent records.

The independent baseline excludes prop-market probabilities, game spreads,
totals and moneylines, creator identity/recommendations/confidence, and closing
prices or later movement. This applies even when the value was available before
the cutoff or appears inside a selected statistical artifact. A queried line
defines the probability question; it cannot estimate the stat distribution.
Market/creator comparison records stay separate. A future market-aware model
needs its own version and evaluation.

## Per-market data readiness

These mutually exclusive dispositions describe predictor-feature capture for
the named minimum feature set. Outcome/population coverage is a separate gate:

- `eligible-for-ingestion`: the minimum source/use, identity and cutoff evidence
  qualify the stated historical and forward window. Implementation can proceed;
  this is not model validation or public-display permission.
- `prospective-only`: minimum fields support forward capture, including an
  initial capture of revised prior-game statistics, but old cutoff versions are
  unverified. Historical exploratory development is permitted with that label.
- `historically-limited`: a verified historical cutoff archive qualifies a
  bounded window or subset, with exclusions recorded; coverage is incomplete.
- `outcome-label-only`: labels qualify, but the minimum pregame features do not.
- `unavailable`: a required field, identity or permitted source use has no
  qualified route for this feature set.

Classify the minimum set, not its best optional enrichment. A verified limited
historical window takes `historically-limited`; an unverified reconstructed
window takes `prospective-only`, never historical eligibility by implication.
An individual player/event can still be unavailable within an otherwise
prospective market. Required-field failures do not become optional because
other fields exist.

`T0` is the first successful capture by the future #52 system, not this research
date. Forward windows begin at or after the captured dependencies' availability
times. The 2021–2025 revised releases are exploratory historical material; no
strict historical cutoff window is selected. Capture at `T0` may bootstrap prior
games for predictions after `T0`; it cannot backdate their availability.

All nine minimum sets currently have the same primary disposition. They use
the same unversioned player-stat releases; assigning different historical
eligibility merely because a market is sparse would confuse data and model
readiness. Each nevertheless has its own field and sample-sufficiency gates.

**Population coverage is blocked for all nine markets.** No qualified
offensive-participation ledger currently establishes the complete eligible
population, including real zero-opportunity games. Player-stat fields support
prospective capture; that does not qualify population-complete outcomes or
model validation. PFR snaps and official NFL participation evidence are
conditional source routes, not a completed ledger. Individual verified labels
can be retained, but their subset must not stand in for every offensive
participant. Missing zero games can bias distributions upward.

Before #54 claims population-complete validation, qualify participation evidence
and populate the ledger for its training, evaluation and feature-history
windows. Account for every market-compatible event roster candidate with GSIS,
canonical game/team, participation state, source/version and availability;
resolve absent/unknown candidates and preserve explicit zero-opportunity
participants with applicable numeric labels. Report covered, excluded and
unresolved counts. Positive usage alone does not enumerate this population.
Until the gate passes, labeled-subset development is exploratory; neither a
stats-only candidate nor missingness disclosure bypasses it.

| Exact registry key | Canonical stat field | Named minimum candidate | Minimum player-stat fields | Predictor-capture disposition | Outcome/population coverage | Market-specific qualification |
| --- | --- | --- | --- | --- | --- | --- |
| `player_pass_yds` | `passing_yards` | `stats-v1:player_pass_yds` | `attempts`, `passing_yards` | `prospective-only` | `blocked`: participation-ledger gate | Positive pooled attempt denominator; preserve volume and signed yardage. No strict old versions. |
| `player_pass_tds` | `passing_tds` | `stats-v1:player_pass_tds` | `attempts`, `passing_tds` | `prospective-only` | `blocked`: participation-ledger gate | Positive attempt denominator; zero TDs are observed counts, not proof that TD probability is zero. #54 validates sparse rates. |
| `player_pass_completions` | `completions` | `stats-v1:player_pass_completions` | `attempts`, `completions` | `prospective-only` | `blocked`: participation-ledger gate | Positive attempt denominator; completions cannot exceed attempts in a reconciled game record. |
| `player_pass_attempts` | `attempts` | `stats-v1:player_pass_attempts` | `attempts` | `prospective-only` | `blocked`: participation-ledger gate | Confirmed participant with zero attempts is distinct from DNP; #54 validates volume/role-change sensitivity. |
| `player_pass_interceptions` | `passing_interceptions` | `stats-v1:player_pass_interceptions` | `attempts`, `passing_interceptions` | `prospective-only` | `blocked`: participation-ledger gate | Interceptions thrown, not defensive interceptions; positive attempt denominator and separate rare-event validation. |
| `player_rush_yds` | `rushing_yards` | `stats-v1:player_rush_yds` | `carries`, `rushing_yards` | `prospective-only` | `blocked`: participation-ledger gate | Positive carry denominator; retain QB/FB examples and negative yardage. |
| `player_rush_attempts` | `carries` | `stats-v1:player_rush_attempts` | `carries` | `prospective-only` | `blocked`: participation-ledger gate | Observed carries, not roster rank or inferred snaps; zero carries need confirmed participation. |
| `player_reception_yds` | `receiving_yards` | `stats-v1:player_reception_yds` | `targets`, `receptions`, `receiving_yards` | `prospective-only` | `blocked`: participation-ledger gate | Positive target denominator; yards per target is distinct from yards per reception. Zero receptions do not imply a missing yardage value is zero. |
| `player_receptions` | `receptions` | `stats-v1:player_receptions` | `targets`, `receptions` | `prospective-only` | `blocked`: participation-ledger gate | Positive target denominator; targets and confirmed catches are separate counts. Zero catches can be an eligible observation. |

Evidence: the inspected 2025 player CSV contains these columns and compatible
positions; its exact hash and row counts are in the source document. The
[player dictionary](https://nflreadr.nflverse.com/articles/dictionary_player_stats.html)
and existing registry/sync mappings establish field identity. Forward capture
is selected for internal research. Missing version history, incomplete zero/DNP
evidence and unverified public-use rights remain explicit qualifications, not
claims that ingestion or a projection is ready to serve. #54 must validate each
market and candidate separately; model support can be narrower than this table.
The predictor disposition and blocked population gate must both appear in that
handoff; completing forward capture alone does not clear the latter.

## Minimum feature construction

Every candidate requires resolved player/event identity, cutoff-eligible
membership, a complete dependency manifest and applicable prior-game records.
This is a pregame contract: cutoff `C` must precede the target kickoff version
known at `C`, and a target already known to have started is ineligible.
The source is the captured nflverse weekly player artifact, with captured
schedule/identity artifacts. Rates are derived from its raw counts, not from
bookmaker probabilities or the current interim hit-rate output.

The proposed data windows are the current NFL season and previous two seasons,
ordered by actual played-event time. Retain separate REG and POST sequences.
Construct candidate last-4, last-8 and last-16 eligible-game summaries within
each sequence, without silently pooling season types. Include the ordered game
IDs, date range, observed/expected/excluded counts and reasons. #54 chooses and
versions which windows and season-type treatment a model actually uses; this
document selects neither a distribution nor a smoothing prior.

Only completed games with event end before the target cutoff can contribute.
Exclude the target event regardless of source-file contents. Do not move to an
older window silently because the most recent relevant game has a delayed or
unresolved row. An exclusion changes the manifest and quality state; a model
must explicitly support that coverage or return unavailable. Record transfers,
long gaps and role changes; an older player's game does not become a current
team observation after a trade.

| Feature ID / market use | Transformation and unit | Rationale and validity | Ordered fallback / all-failed behavior |
| --- | --- | --- | --- |
| `prior_attempts`: all five passing markets | Per-game attempts plus window sum/mean, attempts and attempts/game | Exposure/volume; nonnegative integer raw values; preserve confirmed zero games | Eligible replay capture → separately verified archive version → missing. No current download for an old cutoff. Missing minimum input withholds the candidate. |
| `prior_pass_yards_per_attempt`: passing yards | Sum `passing_yards` / sum `attempts`, yards/attempt, on paired records | Separates efficiency from volume; denominator > 0, signed yardage allowed | Paired replay records → paired verified archive records → unavailable. No league mean or market-implied replacement. |
| `prior_completion_rate`: completions | Sum `completions` / sum `attempts`, fraction | Count consistency; numerator between zero and denominator | Same ordered paired-record fallback; zero denominator is missing, not 0%. Withhold when required. |
| `prior_pass_td_rate`: passing TDs | Sum `passing_tds` / sum `attempts`, TDs/attempt | Retain numerator/exposure and sample counts; all-zero numerator remains observed zero | Same paired-record fallback; no invented positive event or unversioned prior. Missing exposure withholds. Sparse-data probability judgment belongs to #54. |
| `prior_interception_rate`: interceptions thrown | Sum `passing_interceptions` / sum `attempts`, interceptions/attempt | Retain exposure and zero-event counts; use offensive passing field | Same paired-record fallback; missing exposure withholds. Sparse-data validation is independent from TD validation. |
| `prior_carries`: both rushing markets | Per-game carries plus window sum/mean, carries and carries/game | Player opportunity; do not infer from depth rank | Eligible replay capture → verified archive version → missing. Missing minimum input withholds. |
| `prior_rush_yards_per_carry`: rushing yards | Sum `rushing_yards` / sum `carries`, yards/carry, on paired records | Signed efficiency; denominator > 0; QB and non-QB populations remain identifiable | Same paired-record fallback; no zero-denominator division or borrowed player efficiency. Missing minimum rate withholds. |
| `prior_targets`: both receiving markets | Per-game targets plus window sum/mean, targets and targets/game | Target opportunity; attempts are not a target denominator | Eligible replay capture → verified archive version → missing. Missing minimum input withholds. |
| `prior_catch_rate`: both receiving markets | Sum `receptions` / sum `targets`, fraction, on paired records | Distinguishes targets from catches; numerator in [0, denominator] | Same paired-record fallback; zero denominator is missing. Missing required rate withholds. |
| `prior_rec_yards_per_target`: receiving yards | Sum `receiving_yards` / sum `targets`, yards/target, on paired records | Includes catch failure in efficiency; may equal zero with positive exposure | Same paired-record fallback; do not substitute yards/reception under this feature ID. Missing required rate withholds. |

The raw per-game numerator and outcome field accompany every derived summary.
Pool sums, not a mean of per-game rates. Numerator and denominator use exactly
the same game subset and cutoff-eligible artifact versions. Preserve zero-volume
games in volume summaries; exclude undefined per-game ratios only with the
denominator/missingness flag retained. Blank, absent, nonfinite or inapplicable
values remain missing; do not coerce them to zero. Count fields must be
nonnegative integers. Yard fields are integer-valued and may be negative; do not
clip them to satisfy an unsuitable count-model distribution.

One available record establishes a data observation, not sufficient model
history. Record `n_games` and numerator/denominator exposure. #54 sets and tests
market-specific sufficiency, uncertainty and rare-event rules. A constant-zero
sample does not authorize a degenerate zero-probability forecast.

## Optional context and explicit fallback sets

Optional features define enriched candidates; they are not hidden minimum
dependencies of `stats-v1:<market_key>`. The named stats candidates above omit
injury, depth rank, weather, team/opponent context and pace. They are reduced
feature-set candidates for later #54 evaluation, not approved replacement
models. Enriched candidates must enumerate their feature IDs and versions.
Omitting an injury covariate does not bypass a qualified availability exclusion;
that eligibility decision and its dependencies still belong in the manifest.

In each fallback below, an alternative must independently satisfy cutoff,
identity, field semantics, permitted internal use and freshness. A conditional
source whose gate remains open is not a usable fallback. Public outputs have a
separate rights gate even after internal research eligibility.

| Optional feature and use | Source fields / transformation / unit | Decision and ordered fallback | Missingness or conflict outcome |
| --- | --- | --- | --- |
| `prior_team_volume`: passing/rushing/receiving context | Captured weekly team `attempts`, `carries`, `targets`; per-game counts and lagged means | Selected for forward internal capture. Eligible same-source capture → verified historical version → missing; do not substitute sportsbook totals | Omit only by explicitly selecting the applicable `stats-v1:<market_key>` candidate after #54 validation. An enriched request otherwise withholds. |
| `prior_carry_share`, `prior_target_share`: rushing/receiving role proxy | Same-game player `carries` / team `carries`, or player `targets` / team `targets`; fractions | Selected derived forward candidates, with paired-version/denominator checks. Paired capture → verified paired archive → missing. Provider `target_share` is not interchangeable until its denominator is qualified | Zero team exposure is missing. Do not call a share depth rank, routes or snap share. Missing enrichments permit only the named stats candidate. |
| `prior_opponent_context`: all families | Earlier offenses facing the target opponent, from captured team/game identity; attempts, carries, targets, corresponding yards/counts and pooled rates | Selected forward research candidate. Team-stat captures → qualified captured PBP aggregates with identical denominator definitions → verified archive → missing | Define opponent/sample/season-type window and denominators in the feature version. No target-game results. PBP substitution requires validated aggregation parity; otherwise use named stats candidate or withhold. |
| `scheduled_rest_hours`: all families | Target scheduled kickoff minus that event team's previous completed-game scheduled kickoff, divided by 3,600; hours, using schedule versions eligible at the cutoff | Selected forward schedule candidate. Captured eligible kickoff pair → separately qualified official schedule pair → missing | Includes bye gaps; previous game belongs to the target team, not a traded player's former team. Reschedule invalidates the old derivation. No actual-end or completion-observed timestamp in the value. Missing rest alone permits named stats candidate. |
| `recovery_hours`: future recovery context | Target kickoff minus previous game's verified actual completion time, hours | Deferred; requires a separately qualified actual-end source and versioned player/team recovery definition | Completion-observed-at is provider receipt timing, not physical recovery. It cannot fill this feature. Missing actual end remains missing. |
| `venue_roof_context`: weather/context | Actual event venue ID/coordinates, roof capability and cutoff-known roof status; categories | Conditional predictors. Captured event-specific schedule/venue evidence → qualified official venue evidence → unknown | Nominal home venue is not a fallback for neutral/international games. A retractable roof with unknown state is unknown; do not assume outdoor weather reaches the field. Missing optional venue context permits stats candidate. |
| `injury_status`: availability enrichment / hard exclusion | Captured nflverse season/type/week/team/GSIS practice/report categories; raw text and capture times | Selected raw forward capture; predictor/exclusion use conditional on semantics/freshness. Eligible nflverse report → separately qualified ScoreTape change-log report → unknown. ScoreTape gates currently remain open | Missing/blank/report removal is unknown, not healthy. No forward-fill of cleared status by absence. A qualified current OUT/inactive exclusion withholds the projection; conflicting current reports withhold. Unknown status permits only a validated stats candidate with availability explicitly unverified. |
| `depth_rank`: role enrichment | Captured `dt`, team, position/slot/rank, ESPN/GSIS bridge; ordinal within a slot | Selected raw forward capture; predictor use conditional on slot/identity/freshness checks. Eligible depth snapshot → separately qualified official depth evidence → missing. Historical ranks remain conditional | Rank is not a probability, routes or guaranteed snaps. Roster status/recent usage cannot fill this feature ID. Missing rank permits named stats candidate; identity conflict withholds. |
| `forecast_temperature_c`, `forecast_wind_mps`: environment | Forecast value for actual venue and kickoff; °F→°C, mph→m/s or km/h→m/s conversions recorded | Conditional new feature capture. Qualified Open-Meteo capture for non-commercial pilot → NWS for supported U.S. venue → MET Norway for supported venue → missing. Existing live values lack the required history envelope | Require forecast valid-time match and domain/roof checks. Do not use current observations or later runs. Unqualified alternatives are skipped with reasons; missing feature permits named stats candidate only. |
| `forecast_precip_amount_mm`: amount enrichment | Provider accumulation amount and exact forecast interval, mm | Conditional. Qualified Open-Meteo interval → NWS amount with matched interval → MET amount with matched interval → missing | Amount over different intervals is not automatically comparable. No conversion from probability to amount; incompatible interval is unsupported and uses stats candidate or withholds. |
| `forecast_precip_probability`: separate probability enrichment | Explicit probability and interval, fraction; normalize percent / 100 | Conditional. Qualified NWS probability → NOAA NDFD only after every decoder/availability gate passes → missing. No inspected MET probability fallback; existing app uses amount | A 12-hour probability is not an hourly value. All NDFD gates remain open, including nonzero scaling. Use a distinct versioned feature/schema or named stats candidate; never infer from mm. |
| `prior_snap_share`, routes/personnel/charting | PFR snap counts/GSIS bridge; FTN play/player fields with denominators | Conditional PFR research; FTN enrichment deferred. No selected automatic fallback or integration | Rights/identity/timing gates must pass before an enriched feature is created. Required by neither stats candidate nor initial MVP ingestion list. |
| Situation-neutral pace | Captured PBP possession/defense, clock, score, down and play flags; desired unit seconds per offensive snap | Deferred from the initial MVP feature set. PBP capture is selected research, but no clock/filter recipe is qualified as situation-neutral pace | Qualify clock stoppages, possession/quarter boundaries, kneels/spikes, neutral-score/time filters, coverage and versioned aggregation before reconsideration. Plays/game is not a fallback. Initial stats candidates omit pace explicitly. |

Conversions: `C = (F - 32) × 5/9`, `m/s = mph × 0.44704`,
`m/s = km/h / 3.6`. Preserve original unit/product/interval. Temperature and wind
selection uses the closest supported instantaneous valid time within 60 minutes
of scheduled kickoff; ties select the earlier time. This is a proposed feature
policy, not a provider guarantee. Accumulation/probability intervals must satisfy
`start <= kickoff < end` and retain their start/end; interval length is part of
the feature ID or version. Do not stretch a shorter interval, interpolate
probability, or treat missing rain data as a dry forecast.

No automatic fallback is authorized. A future service may use a named reduced
candidate only if that exact market/feature/model version has passed #54,
product integration has been approved, and selection is visible in the response
with missing-feature reasons. If a caller requests an enriched model and no
validated fallback is explicitly allowed, return unavailable. No fallback can
bypass unresolved identity, target-game leakage, rights or a confirmed exclusion.

## Cutoff, provenance and correction envelope

Store UTC instants with explicit timezone parsing; preserve raw local strings
and their timezone. Schedule `gametime` is Eastern; derive its instant from
`gameday` and `America/New_York`, including DST. Do not infer completion from
scheduled kickoff plus an assumed game duration.

Completion timing is an acquisition gate: the inspected weekly stats and
scheduled kickoff do not establish an actual game-end timestamp. #52 must
qualify completed-event evidence. A verified actual end can be used; otherwise
use a conservative bound from the first captured evidence confirming completion,
and identify it as `completion-observed-at`, not actual end. The bound must
precede a predictor cutoff and anchors the finalization delay if actual end is
unknown. Without confirmed completion, neither lagged input nor final label is
eligible. This qualification cannot be bypassed by elapsed scheduled time.
The conservative completion-observed bound supports availability/finalization
only: it is not physical end time and must never enter scheduled rest or recovery
duration. `scheduled_rest_hours` uses two eligible scheduled kickoffs.

Each raw observation and deterministic feature must carry:

| Field group | Required record contract |
| --- | --- |
| Source/artifact | Source/feed, public origin, immutable content hash/artifact reference, schema/version, capture batch and parser version; mutable URL alone is insufficient |
| Raw identity | Source player/game/team IDs, raw name, season/type/week, provider aliases and bridge evidence/version |
| Canonical identity | GSIS player, `canonical_team_id` and internal UUID `canonical_game_id` as defined below, season type, dated membership and target market; identity decision/version |
| Value/meaning | Feature ID/version, typed value or explicit null, unit, denominator, interval, source column and deterministic transformation/version |
| Event/effective time | Verified source game end or conservative completion-observed bound for lagged stats; membership/report effective context where established; forecast valid interval; distinguish source observation/load time from effective time |
| Availability | Source publication time if verified, captured-at, availability evidence and conservative available-at; source issue/reference time may be null or distinct and never substitutes for publication |
| Local processing | Raw ingested-at, derived computed-at and ingestion/run/code identity; these are not retroactive source availability |
| Lineage/quality | Predecessor/superseded observation IDs, correction reason, dependency manifest, provisional/final source state, missing/excluded counts, rights-review/version and quality/unavailable reasons |

For first-party forward capture, use response capture time as conservative
`available_at` when earlier publication is not verified. A nominal forecast run,
depth `dt`, season/week or GitHub `updated_at` alone cannot backdate it.
For a derived feature, data availability is at least the maximum availability
of all raw, schedule and identity dependencies. Preserve all dependencies;
timestamping the final numeric value alone cannot prove cutoff eligibility.

Two read modes must be explicit:

1. **Application-data replay:** raw inputs and identity evidence were captured
   and ingested by this system at or before cutoff `C`. Select the latest valid
   revision then known, not today's newest revision. A deterministic derivation
   computed later can reproduce these inputs; record its later computation/code
   version and do not claim it was originally stored or served at `C`.
2. **Verified historical reconstruction:** an independently verified archive
   establishes bytes, identity and public availability at or before `C`, despite
   later local import. Mark reconstruction/import times; it is not evidence that
   this application held the data at `C`. No such predictor archive is selected
   by this decision. Revised retrospective nflverse data and the current NOAA
   samples remain exploratory, not strict historical reconstruction.

Every contributing source game ends before `C`; every dependency is eligible
at or before `C`. Forecast valid time can be after `C` because the prediction was
issued/captured before it. Equality at `C` is eligible; one instant after it is
not. Availability precision must support the comparison; a day-only timestamp
cannot prove a mid-day cutoff. Unknown availability fails strict reconstruction.

Append corrections and bridge changes with their actual later availability.
For a query before the correction, preserve the earlier observation and join.
For a later query, select the corrected version if otherwise eligible. Never
apply later injury news, roster remapping, role revisions, realized weather,
actual starters, target-game stats or closing prices to an earlier feature row.
Training labels and prediction features have different clocks; #54's training
run can use only label versions available by its training cutoff. Later final
target labels may grade an earlier prediction without entering its features.

Until sufficient prospective snapshots exist, or a verified historical version
archive is selected, reconstructed history supports exploratory development
only. #54 cannot describe its results as strict point-in-time walk-forward
validation. Capturing old outcomes at `T0` permits forward model training at a
later cutoff, with the later-known versions recorded; it does not create old
training-state or predictor versions.

## Player, team and event identity

The MVP keys are concrete and distinct from provider bridges:

| Entity | Canonical key | Initial bridge / stability contract |
| --- | --- | --- |
| Player | GSIS string, stored as `player_id` | nflverse `player_id`/roster `gsis_id`; other provider IDs and confirmed names are versioned bridges |
| Team | `canonical_team_id` TEXT, `nfl:team:<seed abbreviation>` | Seed the 32 franchise keys from the unique values of existing `NFL_TEAM_ABBREVIATIONS`; e.g. `nfl:team:PHI`, `nfl:team:LA`. The seed token is immutable internal identity, not a promise that display name/source abbreviation never changes |
| Game | `canonical_game_id` UUID, minted once by the internal game ledger | nflverse `game_id` and Odds API `event.id` are separate source bridges to that UUID; neither provider ID nor kickoff/week is the internal primary key |

The initial provider-name bridge is a captured, versioned copy of
[`NFL_TEAM_ABBREVIATIONS`](../src/lib/nflStadiums.ts), whose 32 entries map
Odds API display names to current nflverse abbreviations. Capture its code/
mapping version and availability when seeding the predictive ledger. Current
nflverse abbreviation aliases map to the same seeded team keys. This seed is
not proof of earlier provider names or historical membership. Unknown aliases
fail closed; do not derive a code from a city, nickname or prefix. In particular,
the existing map uses `LA` for the Rams and `LAC` for the Chargers.

Team keys represent franchise identity, with dated display names, locations and
source aliases stored separately. A relocation/name change adds alias/location
versions without renaming or reusing the internal team key; a new franchise
requires an explicit new key. Historical provider names/codes require a reviewed
continuity bridge with effective date/season bounds and supporting source
evidence. The inspected schedule contains historical codes such as `OAK`, `SD`
and `STL`; the current mapping alone does not qualify their historical bridges.

Each team/game bridge records source/sport, raw provider ID or exact alias,
canonical key, effective-from/to context, captured/available/ingested times,
evidence/artifact identity, bridge revision and predecessor. At a given effective
time and knowledge cutoff, one raw alias/ID must resolve to exactly one key;
overlaps or conflicting mappings remain unresolved. A later correction appends
a bridge revision and preserves the earlier decision in prior manifests.
Availability and effective time are separate: a modern alias correction cannot
silently rewrite an old cutoff's team/game join.

The future outcome natural identity includes `(GSIS player, canonical_game_id,
season, season_type, stat_type)`. Week is descriptive, not sufficient uniqueness.
The game ledger retains dated team keys, season/type, schedule revisions and
completion evidence; provider bridges retain raw IDs. A verified reschedule or
replacement provider ID for the same contest keeps the internal game UUID and
adds a schedule/bridge revision. A genuinely different replacement contest gets
a new UUID with an explicit predecessor relation, not a merged numeric outcome.
These keys belong to the future predictive records; existing odds tables keep
their raw provider event IDs unless a separate migration deliberately bridges
them.

Resolve an Odds API event using sport, season/type, exact dated home/away team
mapping and scheduled kickoff context. Automatic joins require one unique
candidate with matching teams and the same kickoff instant after timezone
normalization. A changed or approximate kickoff needs an explicit reschedule
link/review; do not choose the nearest game within an arbitrary time tolerance.
Neutral/international venue is a separate fact, not a home-team assumption.
Multiple candidates or a provider replacement event without a verified bridge
remain unresolved. Keep predecessor IDs so rescheduling does not create duplicate
game outcomes or reuse the abandoned forecast/line record silently.

Player joins require GSIS, market-compatible position and dated membership in
an event team as of the cutoff, using the eligible weekly-roster/identity snapshot.
This is evidence of then-known membership, not guaranteed participation in a
future game. Evaluate registry applicability against the dated position for
each prior record as well as the target identity. Preserve
provider ID evidence where it exists. The Odds API description is a display name,
not a stable player ID. Names/aliases can identify candidates but cannot alone
establish the join. An alias confirmed with GSIS, dated membership and unique
context may be versioned; collisions, conflicting IDs and unverified membership
fail closed. PFR/ESPN/provider bridges have their own availability and effective
context. Today's corrected crosswalk cannot silently resolve an old cutoff.

For outcome reconciliation, later official identity evidence may resolve a
label, with that decision's availability recorded. It does not retroactively
resolve a prediction-time identity failure. A manual override is a versioned
decision with evidence and effective scope, not an unlogged replacement.

## Canonical outcome labels

Canonical labels represent the full official player statistic for a completed
game, **including overtime**. The nine fields use the registry mapping above,
not team net yardage or a bookmaker's settlement transform. Preserve source
counts/yardage and any official correction. REG and POST are separate; preseason
is excluded from this MVP data contract. A model must identify its supported
season types and registry positions before serving.

nflverse is the practical label feed. The official NFL gamebook/box-score
benchmark and its permitted-use/correction gates are described in
[source qualification](predictive-data-sources.md#outcomes-usage-and-corrections).
Qualify that reconciliation route before claiming official-source validation.
Record material discrepancies and leave affected labels unresolved; do not
silently favor nflverse or declare a PDF's initial values correction-final.
Public label/stat display still requires its own rights qualification.

The initial model target is explicitly conditional on a market-compatible
player participating on offense. Nonparticipation is separate from equality
with a prop line or a statistic of zero. A future unconditional availability
model requires a different version and evaluation; missing injury data does not
create a probability of participation.

| Player/event state | Canonical label behavior |
| --- | --- |
| Confirmed offensive participant; applicable statistic explicitly present | Eligible numeric observation, including zero, subject to finalization/identity gates. Positive passing attempt, carry or target is evidence of offensive participation; all-zero stats alone are not. |
| Confirmed offensive participant with no attempts/carries/targets for this specific statistic | Explicit official/reconciled zero is an eligible zero label. Blank/missing field remains missing; zero exposure makes an efficiency ratio undefined. |
| Official inactive or DNP | Record the distinct participation state; exclude from this conditional statistical target. Do not synthesize zero, Under, push or sportsbook void. |
| Confirmed zero offensive participation, including special-teams-only | Record `zero_offensive_participation`; exclude from this target even if a feed fills offensive fields with zeros. |
| Participation unknown or all-zero row without independent participation evidence | `participation-unverified`; no training/grading label until qualified evidence resolves it. Weekly roster ACT or depth rank alone is insufficient. |
| Player/game/season-type identity unresolved or statistic inapplicable to registry position | No canonical label; retain raw evidence and reason for resolution. |
| Postponed/rescheduled, not played | No label until the actual completed event and predecessor mapping are resolved. |
| Canceled/unplayed | Terminal `unplayed` record, no numeric label. |
| Suspended/unfinished | Provisional event record; withhold final labels until official completion/termination and the rule for recorded official stats are resolved. No partial-game total masquerading as full-game final. |

A missing row cannot prove DNP, zero participation or zero statistic. Player
stats may omit players with no recorded usage; a complete eligible-population
ledger therefore needs separately qualified participation evidence. PFR snaps
and official gamebooks remain gated sources. #54 must report excluded/unknown
participants and test selection bias; it cannot validate a population of all
offensive participants from only players with positive usage. This is a real
label-coverage gate, not permission to drop inconvenient zero games silently.
As recorded in every readiness row, population coverage remains **blocked**
until the qualified ledger accounts for zero-opportunity offensive participants
throughout the claimed training/evaluation/history windows. Reporting the bias
or capturing predictor features does not itself clear that blocker.

Proposed finalization policy `canonical-label-finalization-v1`:

1. Capture postgame observations as provisional, with verified actual completed-at
   or the conservative completion-observed bound above, plus observed versions.
   An event without confirmed completion stays delayed/provisional.
2. The earliest operational-final time is the later of the completion timestamp/
   bound + 72 hours and the first Thursday 12:00 UTC after that timestamp/bound.
   The Thursday component follows the documented Wednesday-to-Thursday
   correction refresh; 72 hours
   and the 12:00 UTC margin are project policy, not an NFL guarantee.
3. Finalization additionally requires a successful post-window source capture,
   confirmed completed event, applicable explicit statistic, resolved identity/
   participation, no material discrepancy and a qualified reconciliation policy.
   If the refresh is delayed or these checks fail, remain provisional/unresolved;
   elapsed time alone never fabricates a final label.
4. Later corrections create a new label version with actual availability,
   reason and predecessor, including after operational finalization. An earlier
   evaluation keeps its recorded label version; any recomputed metrics use a
   separately identified label set. Operational-final does not mean immutable.

The nflverse
[update schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html)
recommends the correction refresh; it does not promise all official changes stop
then. Store label policy/version, authority/feed, participation/identity state,
raw stat, label version, observed-at, finalization eligibility and finalization
time. Training uses the eligible label version known at its cutoff. A suspended
game does not reuse a window based on its originally scheduled date.

Bookmaker overtime, participation, injury, cancellation and void rules belong
to a separate settlement record with bookmaker/rule version. The canonical
stat label is not a promise that a wager settles the same way. Push means stat
equality for an eligible played outcome; void/unplayed/unresolved is not push.

## Arbitrary-line probability and #54 amendment

For finite supported line `L` and the model's eligible outcome `X`, require:

```text
overProbability  = P(X > L)
underProbability = P(X < L)
pushProbability  = P(X = L)
overProbability + underProbability + pushProbability = 1
```

All nine canonical outcomes are integer-valued, including possibly negative
yards. At an integer line, probability mass at equality can be positive. At a
half-point or any non-integer line, equality is impossible and push probability
is zero. Validate finite line input and the market's supported line domain;
fractional numeric values do not turn an integer statistic into a continuous
target. #54 chooses distributions that respect each market's support.

Over/Under probabilities are unconditional on a no-push result within the
eligible-participant target. If a consumer needs no-push conditional
probabilities, identify them separately as `over / (1 - push)` and
`under / (1 - push)` when `push < 1`; they are undefined when `push = 1`.
Never rename these conditional values as the unconditional probabilities.
Fair-price/EV calculations must state how pushes and settlement differences
are handled; normalizing away push mass silently is not an acceptable service
contract. #54 owns that implementation and evaluation, not #49.

[Issue #54](https://github.com/ven2dev/dfs-ev-demo/issues/54) currently asks for
arbitrary supported points with complementary Over/Under probabilities and
complementarity tests. The required handoff amendments are:

- Replace universal two-way complementarity with the three probabilities above,
  keeping two-way complementarity only when push is impossible.
- Include `pushProbability`, target participation conditioning, line support,
  label/feature/model versions and explicit unavailable reasons in the service
  contract. Unavailable has no probability triple, including no fake zeros.
- Test integer-line equality mass, half-point zero push, signed yardage support,
  total mass, degenerate all-push handling and settlement separation.
- Evaluate push-capable outputs with a documented outcome/scoring convention;
  do not force pushes into Over/Under for Brier score, log loss or calibration.
- Enforce data/label availability at walk-forward training and prediction
  cutoffs; reconstructed unversioned history remains exploratory.

Step 3 must update the live #54 issue body before #49 closes. Preserve unrelated
scope while correcting its model contract, probability acceptance criterion,
test criterion and relevant population/cutoff validation requirements. Re-read
the saved issue and record the update/diff and issue link as closure evidence;
a document handoff or issue comment alone does not satisfy this closure gate.
This targeted Step 2 commit does not yet edit the issue body.
The existing `computeEV` heuristic remains interim until a validated version is
deliberately integrated.

## Missingness and response contract

Record raw observation status separately from whether a candidate can run.
Never collapse every unavailable cause into numeric zero or an empty success.
The future response identifies requested/selected candidate and model versions,
cutoff, dependency/identity/label versions, feature quality and reason codes.

| State | Required-input behavior | Optional-input behavior |
| --- | --- | --- |
| `missing` | Withhold; no inferred zero or population mean | Named stats candidate only if validated and explicitly allowed |
| `stale` | Withhold where current evidence is required; preserve the expired record | Named stats candidate only; do not present old status/forecast as current |
| `delayed` | Record pending source/event and withhold required coverage | Same explicit candidate rule; no silent last-game exclusion |
| `corrected` | Choose only the revision eligible at the requested cutoff; unresolved conflicting corrections withhold | Record correction/version; do not rewrite an earlier analysis |
| `conflicting` | Withhold identity, participation or required values until reconciled | Do not bypass an OUT/identity conflict through a reduced candidate |
| `unsupported` | Reject unsupported market/position/line domain or product semantics | No substitution of a different unit, interval or feature ID |
| `rights-unverified` | Exclude source/use and withhold if no eligible alternative | Omit only via explicit candidate selection; public display has its own gate |
| `historically-unverified` | Withhold strict reconstruction; exploratory mode clearly identified | No strict-validation claim from revised history |
| `unresolved` | Withhold player/event joins and applicable labels | No name-only, nominal-venue or modern-roster identity fallback |
| `insufficient-data` | #54's per-market gate withholds or reports its expressly validated low-data behavior | Optional omission does not fix missing minimum exposure/history |

Step 3 sets source-specific freshness budgets, outage/retry ceilings and costs.
Until those policies are set and implemented, no status/forecast feature is
declared production-fresh. Lagged statistics are intentionally historical;
their recency window, latest-game coverage and revision state must be visible,
not mislabeled stale just because an earlier game occurred months ago.

## Contract walkthroughs and verification evidence

These are documentation checks, not predictive tests or recorded production
captures. The source rows below were read from the hashed 2025 player sample in
the source document. The schedule sample maps `2025_15_LV_PHI` to
2025-12-14, 13:00 Eastern / 18:00 UTC. Membership bridges, future target event,
capture times and cutoff used in the walkthrough are explicitly **synthetic**;
they demonstrate the contract and do not verify a live Odds API event or past
availability. No production query or provider credential was used.

| Role | Actual public sample identity / prior game | Actual raw counts | Derived single-game illustration |
| --- | --- | --- | --- |
| QB | Jalen Hurts, GSIS `00-0036389`, PHI QB, `2025_15_LV_PHI` | Attempts 15, completions 12, passing yards 175, passing TDs 3, passing interceptions 0 | Completion rate 12/15 = 0.8; yards/attempt 175/15 ≈ 11.6667; TD rate 3/15 = 0.2; interception rate 0/15 = 0 |
| Rusher | Saquon Barkley, GSIS `00-0034844`, PHI RB, same game | Carries 22, rushing yards 78 | Yards/carry 78/22 ≈ 3.5455; observed carries remain 22 |
| Receiver | A.J. Brown, GSIS `00-0035676`, PHI WR, same game | Targets 2, receptions 2, receiving yards 41 | Catch rate 2/2 = 1; yards/target 41/2 = 20.5; one game's rate is not a calibrated forecast |

For each row, the fixture event has uniquely verified teams/season/type/kickoff,
dated PHI membership, GSIS/alias and registry-position evidence available before
fixture cutoff `2026-10-12T16:00:00Z`. The fixture's old-stat artifact was captured
and ingested at `2026-10-11T12:00:00Z`; its manifest references the actual sample
hash. Thus the old values can inform this hypothetical later cutoff. They
cannot inform a 2025 cutoff from this evidence. A receiving request for Jalen
Hurts fails the existing position boundary, despite his raw receiving columns.

The synthetic pipeline resolves provider description plus dated membership to
GSIS, maps the target event separately from the prior game, selects eligible
versions, constructs paired window features, then records the candidate manifest.
There is only one illustrated prior game; #54 must reject it if insufficient.
No event or alias bridge is inferred merely from these abbreviated stat names.

| Walkthrough | Expected contract result |
| --- | --- |
| Later correction captured at 16:01Z changes a prior stat from 175 to 180; prediction cutoff is 16:00Z | Use the earlier eligible 175 version. A later-cutoff run may use 180 with new lineage. No backdated correction. |
| First capture is Oct 11; requested reconstruction cutoff is Oct 10 | `historically-unverified`, no strict replay. The game's 2025 date does not backdate availability. |
| All predictors are captured but the ledger omits participants with zero opportunities | Predictor capture stays `prospective-only`; outcome/population coverage stays `blocked`. No population-complete #54 validation or silent zero-game exclusion. |
| Synthetic target kickoff Oct 12 at 20:00Z; team's previous kickoff Oct 5 at 20:00Z; completion observed late on Oct 8 | `scheduled_rest_hours` = 168 from the eligible kickoff pair. Observation delay changes evidence availability, never physical rest. `recovery_hours` needs a verified actual end and remains deferred. |
| Depth `dt` precedes cutoff but artifact/bridge was first captured afterward | Reject that role feature at the earlier cutoff. A load timestamp alone cannot qualify it. |
| Weather required by enriched request is missing or NDFD gate remains open | Enriched request unavailable unless it explicitly permits a validated `stats-v1:<market_key>` candidate. No zero wind/rain. |
| Unknown injury report with otherwise eligible raw stats | Only an explicitly allowed validated stats candidate may run, with participation conditioning and availability-unverified quality; no healthy claim. |
| Current eligible report confirms OUT, or membership/GSIS conflicts | Withhold even if the stats candidate exists; it cannot bypass this exclusion/identity gate. |
| Integer label 80 at line 80 | Grading outcome is push. A synthetic distribution with under 0.45, push 0.10 and over 0.45 has total mass 1; Over + Under alone is 0.90. |
| Same integer statistic at line 80.5 | Push probability is 0; under includes mass at 80. For that synthetic distribution, under 0.55 and over 0.45 sum to 1. |
| All modeled mass equals an integer line | Push 1, Over/Under 0. No-push conditional probabilities and no-push fair price are undefined. |
| Official full-game receiving total includes 9 overtime yards, total 80 | Canonical label is 80, including overtime; a book's overtime exception stays in its settlement record. |
| Inactive/DNP or confirmed zero offensive participation | No numeric training/grading label for this conditional target; preserve distinct state. It is neither Under nor push. |
| Confirmed offensive participant with explicit zero receptions and two targets | Zero reception label eligible after finalization; catch rate 0/2 valid. Missing receptions would remain missing. |
| Rescheduled provider event has no verified predecessor link | No target join or label; do not duplicate or use the abandoned kickoff/forecast. Resolve mapping before finalization. |
| Completed Sunday 2026-10-11 at 20:00Z | +72h is Wed Oct 14 at 20:00Z; next Thu 12:00Z is Oct 15. Earliest operational finalization is Oct 15 at 12:00Z, plus a successful eligible capture and the remaining checks. |
| Stat correction arrives after the finalization window | Append a new label version; earlier evaluation retains its version. Re-evaluation has a new label-set identity. |
| Numeric outcome exists but GSIS/event or participation is unresolved | No canonical label until qualified evidence resolves the uncertainty; numeric presence alone is insufficient. |

Verification for this documentation step: compare all nine readiness/stat/
position mappings with the actual registry; check minimum fields against the
hashed sample; recompute the illustrative ratios, push totals, unit conversions
and finalization date; trace all three identities through the fixture contract;
check Markdown/local links and `git diff --check`. Full application/DB suites are
unnecessary for a documentation-only change. Hosted CI still runs on the future PR.

## Downstream ownership

#52 owns source/schema/capture implementation, dependency and identity manifests,
append-only corrections, label/participation ledgers and cutoff queries after
#60's migration delivery. It must prove replay/correction boundaries, zero versus
missing, reschedules and rights/source gates rather than reuse current upserts
as historical evidence. Seed stable team keys from the versioned existing map,
mint canonical game UUIDs, and preserve provider aliases/bridges. Qualify and
populate the participation ledger separately from predictor capture.

#54 owns candidate distributions, window selection, population/season-type
support, sample sufficiency, calibration, scoring conventions and push-aware
service/fair-price behavior. It must validate each market and any reduced
candidate before deliberate integration. Public output rights and operational
headroom remain gated. #53 owns eventual presentation of model identity,
uncertainty and unavailable states. Step 3 completes costs, freshness, final
source/feature dispositions and the #49 acceptance mapping, and updates the
live #54 body. #49 closure is gated on verification that the conflicting
two-way complementarity instructions have actually been replaced.
