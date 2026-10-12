# Predictive source decision, costs and operational handoff

Decision and public-pricing review date: 2026-10-05. This completes the
documentation decision for [#49](https://github.com/ven2dev/dfs-ev-demo/issues/49).
The [source qualification](predictive-data-sources.md) owns provider evidence;
the [feature contract](predictive-feature-contract.md) owns fields, identities,
cutoffs, labels and probability semantics. This document owns operating policy,
cost assumptions and the implementation handoff. None of these documents
activates a feed, changes the current weather provider, or validates a model.

## Final decision and remaining gates

Start with free-provider, forward-captured nflverse player/team statistics,
schedules, identifiers and weekly membership. Capture raw injury/role
observations for research; their predictor semantics have separate gates.
All nine registry markets have prospective-only minimum predictor capture,
with named `stats-v1:<market_key>` candidates. **All nine still have blocked
outcome/population coverage** until a qualified offensive-participation ledger
accounts for zero-opportunity participants across the claimed history. Positive
usage rows alone cannot clear that gate. No candidate is approved for serving.

Strict old predictor versions, complete participation evidence, official-label
reconciliation and public/commercial output rights remain open. These are
implementation/launch gates, not implied successes of source selection.
Until a verified historical version archive or sufficient prospective snapshots
exist, #54 can use reconstructed history only for exploratory development. It
cannot advertise that evaluation as strict point-in-time validation. A stats-only
candidate does not bypass population, identity, cutoff or rights requirements.

The independent distribution excludes prop probabilities, spreads, totals,
moneylines, creator inputs and closing/later prices. Weather remains independent
of The Odds API. Existing live Open-Meteo values are not immutable forecasts.
Market data and creator evidence stay in separate comparison records.

The complete candidate-by-use dispositions in the source matrix remain
authoritative. This delivery summary resolves the initial implementation scope:

| Source/use | Final disposition | Initial #52 delivery / gate |
| --- | --- | --- |
| nflverse player/team statistics | Selected: internal forward research capture and practical postgame label feed | Capture explicit counts/yardage and versions; label finalization, completion, reconciliation and population gates still apply. Old revised predictors are exploratory. |
| nflverse schedules, player IDs and weekly rosters | Selected: internal forward identity/membership research | Concrete canonical keys and append-only bridges; actual venue/roof and historical cutoff status remain conditional. Current rosters do not prove old membership. |
| nflverse injuries and depth charts | Selected: raw internal forward observations | Capture categories/ranks, missingness and identity versions. Predictor/exclusion semantics and historical depth evidence are conditional; strict old injury revisions are deferred. |
| nflverse play-by-play | Selected: forward prior-game context research and represented-game postgame analysis | Optional bounded research acquisition, outside the default seven-feed budget below. Historical predictor versions are conditional. Situation-neutral pace recipe is deferred from the initial feature set. |
| PFR snaps through nflverse | Conditional: participation/lagged research | Qualify PFR rights, GSIS bridges, complete zero-participation semantics and cutoff coverage before ingestion. No automatic fallback. |
| Official NFL gamebooks/box scores | Conditional: manual reconciliation benchmark | Qualify project use, corrections and identity. Automated ingestion/redistribution has no approved route. A benchmark candidate is not a completed participation ledger. |
| Open-Meteo / NWS / MET Norway current forecasts | Conditional: prospective enrichment | Follow the feature-specific fallback order, venue/roof/interval and rights gates. Open-Meteo new free capture is non-commercial only. No runtime provider replacement. |
| NOAA NDFD / GFS archives | Conditional: historical forecast candidates | NDFD independent decoder, nonzero PoP, venues, lead times, missingness and availability checks remain open; GFS needs its own decoding/coverage probe. Not a strict-history bridge yet. |
| ScoreTape injury change log | Conditional: forward injury alternative | No authenticated payload, identity/clearance/retention qualification yet; broader history/public display deferred. No account or key requested. |
| BALLDONTLIE / Sportradar | Deferred: paid options | Revisit only for a demonstrated unresolved need, verified cutoff coverage and permitted retention/output use. |
| SportsDataIO | Rejected: point-in-time injury/depth MVP | Inspected final/game-start history does not establish the required revision contract. |
| NFLMeta | Deferred: wrapper | Does not establish independent revision history; commercial access is paid. |
| API-Sports | Rejected: public-product selection | Free requests do not qualify public/commercial rights or cutoff history. |
| FTN participation / charting | Rejected: delayed participation for current-season lagged use; charting deferred | Distinct feeds. Optional charting requires timestamp, rights and CC BY-SA compatibility qualification. |
| Sportsbook / creator records | Rejected: independent predictor use | Keep evaluation/evidence separate; future market-aware versions require their own #54 evaluation. |

Each use above has one disposition; different uses of the same feed may differ.
Public raw-stat/identifier/status display and commercial derived outputs from
the core nflverse feeds remain **conditional**, with no launch permission
inferred from CC BY attribution. PFR/FTN display is deferred. Bulk redistribution
is unavailable without separate qualification and approval. NOAA/MET source
credit and license requirements, NWS's identifying User-Agent, and Open-Meteo's
access terms remain as documented in Step 1. No images/logos are selected.

Every proposed feature is resolved in the
[minimum construction](predictive-feature-contract.md#minimum-feature-construction)
and [optional-context table](predictive-feature-contract.md#optional-context-and-explicit-fallback-sets):
minimum counts/rates and forward team/share/opponent/rest candidates are
selected for internal research; injury/depth predictor use, venue/roof and all
new forecasts are conditional; recovery hours, snap/charting enrichments and
situation-neutral pace are deferred or conditional as individually stated.
No optional feature is secretly required by the nine named stats candidates.

## Operating profiles and shared acquisition

These are future #52 sizing profiles, separate from the existing odds collector's
`free-pilot` profile. Reuse its durable
[`odds_free_pilot_selections`](odds-collector-operations.md#data-dictionary-and-as-of-semantics)
weekly event pin and already-retained event metadata; selecting predictive
checkpoints makes no additional Odds API request and does not expand the
collector's one-event-per-NFL-week claim or paid quota. Low samples one manually
chosen known event/month; expected follows one existing pin/week (approximately
four/month); high covers five weekly pins in a month spanning five selections.
Missing pins or unresolved event/venue bridges remain explicit gaps.

| Profile | Acquisition / execution | Persistence and product boundary |
| --- | --- | --- |
| Development | Fixture/disposable local Postgres first; optional bounded public samples outside Git, run manually | Local disk only; no production credentials or paid requests. Source samples are research, not live model readiness. |
| Predictive free-pilot | 1/4/5 target events/month (low/expected/high), reusing existing weekly pins; 4–30 shared capture batches/month | Use only approved non-commercial access. Local/manual execution or once-daily Hobby cron can test capture. No freshness or public-serving claim. |
| Scheduled production | NFL-wide shared captures, 30–360 batches/month; optional event forecasts after qualification | Requires verified hosting plan, persistence, rights and budgets. Four/twelve batches per day require a scheduler that supports them; no activation in #49. |

Default sizing uses seven logical capture groups: player stats, team stats,
schedule, player identifiers, weekly roster, injuries and depth charts. The
endpoint list and metadata reuse must be verified in #52; seven groups do not
claim seven distinct release URLs. Seasons/feeds are shared across users and
markets, and a forecast is shared by actual venue/event/forecast version.
No upstream call is made per viewer or per prop. Cold bootstrap and optional
PBP/participation/NOAA acquisition have separate budgets below.

### Exact raw-column allowlists

`predictive-raw-allowlist-v1` permits only the following columns in normalized
raw records for the seven groups. The capture/provenance envelope is generated
separately, not read from invented CSV columns. Required identity/context and
each market's minimum statistic fields must pass #52 validation; permitted
nullable fields are not permission to synthesize absent values. Validate the
active artifact header and register its parser/schema version before publishing.
An old schema, missing required column or conflicting season-type values fails
closed; future aliases/extra columns require an explicit reviewed allowlist
version. This is a documentation contract, not an implemented ingestion filter.

| Capture group / artifact | Exact permitted raw columns | Use restriction |
| --- | --- | --- |
| Player statistics / `player_stats_<season>.csv` | `player_id`, `player_name`, `player_display_name`, `position`, `position_group`, `season`, `week`, `season_type`, `game_id`, `team`, `opponent_team`, `attempts`, `completions`, `passing_yards`, `passing_tds`, `passing_interceptions`, `carries`, `rushing_yards`, `targets`, `receptions`, `receiving_yards` | Completed-game lagged usage and applicable labels only, subject to availability/participation/finalization gates. Never target-game pregame inputs. Calculate shares/rates from paired raw counts rather than importing unqualified provider ratios. |
| Team statistics / `team_stats_<season>.csv` | `season`, `week`, `season_type`, `game_id`, `team`, `opponent_team`, `attempts`, `completions`, `passing_yards`, `passing_tds`, `passing_interceptions`, `carries`, `rushing_yards`, `targets`, `receptions`, `receiving_yards` | Completed prior-game team/opponent context with defined windows and denominators; not same-game predictors or situation-neutral pace. |
| Schedules / `games.csv` | `game_id`, `season`, `game_type`, `week`, `gameday`, `gametime`, `away_team`, `home_team`, `location`, `roof`, `surface`, `stadium_id`, `stadium`, `old_game_id`, `gsis`, `nfl_detail_id`, `espn`, `pfr` | Capture scheduled context and raw event bridges. Actual venue/roof predictors remain conditional; these fields are not proof of roof state, completion or original historical availability. |
| Player identifiers / `players.csv` | `gsis_id`, `display_name`, `common_first_name`, `first_name`, `last_name`, `short_name`, `football_name`, `suffix`, `nfl_id`, `espn_id`, `pfr_id`, `smart_id`, `esb_id`, `position`, `position_group` | Versioned identity/name bridges and position hints. Latest position is not historical membership/role evidence. Do not import `latest_team`, `status`, headshots or unqualified proprietary position/status fields through this group. |
| Weekly rosters / `roster_weekly_<season>.csv` | `season`, `week`, `game_type`, `team`, `gsis_id`, `full_name`, `first_name`, `last_name`, `football_name`, `position`, `jersey_number`, `status`, `status_description_abbr`, `espn_id`, `pfr_id`, `sportradar_id` | Dated membership/status and identity research. ACT is not a game-day active list, participation or proof of a zero outcome; weekly grain is not publication evidence. |
| Injuries / `injuries_<season>.csv` | `season`, `season_type`, `game_type`, `team`, `week`, `gsis_id`, `position`, `full_name`, `first_name`, `last_name`, `report_primary_injury`, `report_secondary_injury`, `report_status`, `practice_primary_injury`, `practice_secondary_injury`, `practice_status` | Raw report-cycle observations; no supplied publication/revision time or complete post-inactives ledger. Missing/blank/removal remains unknown. |
| Depth charts / `depth_charts_<season>.csv`, inspected 2025 schema | `dt`, `team`, `player_name`, `espn_id`, `gsis_id`, `pos_grp_id`, `pos_grp`, `pos_id`, `pos_name`, `pos_abb`, `pos_slot`, `pos_rank` | Timestamped role research. `dt` is load time, ranks are slot-specific ordinals and GSIS revisions remain versioned. Legacy 2024 columns need a separately qualified adapter/allowlist. |

All unlisted schedule columns are excluded from normalized predictive input.
In particular:

- Market inputs: `away_moneyline`, `home_moneyline`, `spread_line`,
  `away_spread_odds`, `home_spread_odds`, `total_line`, `under_odds`, `over_odds`.
  These are prohibited independent features even if known before kickoff.
- Realized results/weather and starter fields: `away_score`, `home_score`,
  `result`, `total`, `overtime`, `temp`, `wind`, `away_qb_id`, `home_qb_id`,
  `away_qb_name`, `home_qb_name`. Their latest schedule values cannot enter the
  same game's pregame feature row; outcomes use the separate qualified label feed.
- Other unselected columns: `away_rest`, `home_rest`, `away_coach`, `home_coach`,
  `referee`, `weekday`, `div_game`, `pff`, `ftn`. Some may be knowable pregame,
  but neither their earlier versions nor their transformations are selected.
  Derive `scheduled_rest_hours` from the eligible kickoff pair as specified.

Preserve raw IDs as strings and register explicit `season_type`/`game_type`
normalization; do not silently merge REG/POST or guess a missing game. A permitted
column still needs cutoff, identity and rights eligibility before feature use.
Full immutable source bases may contain excluded columns for artifact integrity;
keep them outside normalized features and model dependency manifests, with no
automatic `SELECT *` or display path. Hashing/archiving cannot authorize their
use as predictors.

Column verification on 2026-10-05: every listed column is present in the saved
2025 player/team/injury/depth headers, saved schedule header, or bounded 4,096-byte
header probes of
[`players.csv`](https://github.com/nflverse/nflverse-data/releases/download/players/players.csv)
and
[`roster_weekly_2025.csv`](https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_2025.csv).
The probes do not measure full sizes, row completeness, historical availability
or rights. The [player loader](https://nflreadr.nflverse.com/reference/load_players.html)
and [weekly-roster loader](https://nflreadr.nflverse.com/reference/load_rosters_weekly.html)
identify those distinct feeds. Other samples, hashes and parsing are recorded
in [Step 1](predictive-data-sources.md#direct-findings-and-workload-references).
Reproduce each header probe outside Git with
`curl --fail --silent --show-error --max-time 15 -L --range 0-4095 --max-filesize 4096 <asset-url> -o <temporary-file>`
and `next(csv.reader(file))` using Python's CSV parser. Header presence does not
close the source's unresolved payload/semantic gates.

### Acquisition policy

Proposed acquisition policy:

- Player/team postgame captures daily, plus a post-correction capture after the
  finalization window. Capture schedules/IDs/membership daily and depth research
  up to every six hours if the approved profile permits. Injury acquisition follows
  the actual team/event report cycle, with a separate qualified post-inactives
  checkpoint for near-kickoff enriched analysis; routine polling cannot replace it.
  The high sizing scenario is an hourly-ish sensitivity envelope (12 batches/day),
  not an instruction to download every file 12 times daily.
- Check metadata/conditional responses once per shared feed poll; download only
  changed artifacts, then content-hash and deduplicate. An unchanged upstream
  response is still a capture/health observation referencing the retained bytes.
  Reuse the existing nightly artifact only when the exact bytes, capture and
  complete provenance are available; do not assume that today's upserted stats
  recover yesterday's version.
- Optional prospective weather qualification budgets 2/4/8 checkpoints per
  event. #52 must schedule these against eligible venue/kickoff versions and
  implement the feature contract's interval/freshness checks. A missed checkpoint
  is missing data; daily Hobby cron cannot promise near-kickoff precision.
- Allow at most three total attempts per request, including the initial attempt.
  Honor `Retry-After`, use jitter/backoff for timeout/429/5xx, and stop at the run
  deadline. Do not retry schema/identity/rights failures as network failures.
  Failed captures never borrow a later response's earlier timestamp.
- Enforce response-byte, row, batch, request and elapsed-time caps; #52 sets
  measured caps before activation. Stage outside the application DB, publish
  a validated batch atomically, and retain a checkpoint for bounded resumption.
  Quarantine unexpected fields/schema drift without promoting partial input.

GitHub's unauthenticated metadata allowance is 60 requests/hour, with secondary
limits; release assets are separate. Budget the existing sync's requests too.
Seven groups × three attempts is 21 metadata calls per batch; serialize/rate-limit
catch-up work rather than bursting several batches after downtime. The
[upstream schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html)
is an intended update cadence, not an SLA or measured publication latency.

## Freshness, corrections and degradation

Freshness is checked at the requested cutoff against eligible retained
observations, never against a later refresh. The feature contract's identities,
completion evidence, forecast valid time and availability bound take precedence.
Proposed operational thresholds below are project policy for #52 validation,
not upstream guarantees or new changes to the live cache:

| Input / state | Acquisition or freshness policy | Response / evidence |
| --- | --- | --- |
| Player/team lagged stats | Latest successful completed-game capture; daily poll, correction-window refresh | An older game's age alone is not staleness. An eligible missing newer completed-game version is a history gap; expose window/exclusions. Final labels require the post-window capture and all label gates. |
| Schedule, membership, IDs | Capture daily; enrichment requires a successful check within 24h of cutoff | Missing/ambiguous canonical identity withholds; a current roster never fills an old cutoff. A reschedule appends bridge/schedule versions and invalidates affected derivations. |
| Depth/role research | Proposed maximum capture age 6h at cutoff, plus slot/identity/effective-context checks | A newly downloaded old depth snapshot is not current role evidence. Missing rank permits only the explicitly allowed validated stats candidate; conflict withholds. |
| Midweek injury reports | Use the actual team/event practice and game-status report cycle, latest expected report and verified publication/effective context at cutoff | Poll/capture time alone cannot make an earlier report current. Unknown cycle/publication or a missed expected report is availability-unverified; missing/blank/removal is not healthy. |
| Game-day availability after the inactive-list milestone | Near-kickoff enriched analysis requires qualified event-specific post-inactives evidence captured and available at or before cutoff, reflecting both teams' relevant report cycle | A six-hour observation or a download after T-90m without proof of post-inactives content cannot qualify. If no qualified source/checkpoint exists, return availability-unverified and withhold the enriched candidate; a validated explicitly permitted stats fallback must retain that reason. Qualified OUT/inactive or conflicting availability still withholds. |
| Optional forecasts | Proposed capture age <=6h plus kickoff-valid interval and actual venue/roof checks | Select only independently qualified fallbacks. Unknown roof/venue, stale issue, unsupported domain or absent message permits a validated named stats candidate only; otherwise unavailable. |
| Delayed/outage | Keep the last verified capture and record failure/deadline/next attempt | Do not advance freshness, invent a label, or re-date retained bytes. Enriched requests withhold when their threshold fails. |
| Corrected | Append observation/label version with availability and predecessor | Cutoff reads and past evaluations retain their chosen versions; recomputation receives a new manifest/label set. |
| Conflicting | Retain both raw claims and evidence; quarantine material discrepancy | Do not silently choose nflverse over the official benchmark, newest over authoritative, or a name match over identity evidence. Record resolution/version before eligibility. |
| Unsupported / rights-unverified / historical timing unverified | Preserve reason and scope | No automatic substitute. Optional absence can permit only an explicitly selected, validated `stats-v1:<market_key>`; hard identity/population/cutoff/rights gates cannot be bypassed. |

Only #54 validation and deliberate product integration can authorize serving a
candidate or reduced-feature fallback. A confirmed inactive/DNP/unplayed event
is excluded, not a zero result or push. Provisional/unresolved labels remain
separate from finalized eligible outcomes.

[NFL Football Operations](https://operations.nfl.com/game-operations-logistics/preparation-safety/game-and-stadium-prep)
places exchange of the Game Day Administration Reports, including inactive
lists, at the 90-minute pre-kickoff meeting. This is a league milestone, not an
API-delivery guarantee. #52 must qualify permitted access, event/player mapping,
complete report semantics, actual publication/capture and correction handling;
the selected injury/weekly-roster feeds are not qualified for that checkpoint
today. At a cutoff before publication, later inactive information is unavailable
and cannot be replayed backward. After the milestone, stale or incomplete
evidence never becomes a claim of current game availability. Reschedules require
the report to match the resolved game/kickoff version. Neither omission from an
unqualified list nor weekly ACT proves active status or offensive participation.

## Reproducible retention and storage assumptions

Do not save an entire mutable annual CSV for every poll. Retain one immutable
base plus content-addressed lossless changes/checkpoints, response metadata,
parser/schema/license versions and capture manifests. Every retained input
must be replayable from those retained bytes. The artifact contract may use
an exact lossless selected-field projection with its field/schema/hash manifest;
that proves reproduction of the selected input, not the discarded full file.
Keep an origin hash as evidence, but a hash/URL alone cannot reconstruct bytes.
The initial full files below conservatively budget one base per group/season.

Keep current plus prior two seasons' relevant observations, with an initial
36-month revision-retention estimate. Season boundaries and pinned evaluations
may require longer retention. Never prune a version referenced by a retained
training/evaluation/reconciliation manifest; store pinned history separately
and add its measured cost. Unreferenced, superseded staging downloads may be
removed after verified durable publication. Terms limiting retention override
the budget: a conditional feed cannot be retained just because storage is cheap.

The measured 2025 reference artifacts are 8,656,387 bytes of player statistics,
229,660 team statistics, 696,006 injuries and 52,917,870 depth charts, totaling
62,499,923 bytes. Add **assumed**, unmeasured schedule/IDs/weekly-roster envelopes
of 1/1/6 MB: 70,499,923 bytes, rounded up to **71 MB per full seven-group pass**.
The 2026 depth asset alone is 57,941,923 bytes, so 71 MB is a reference estimate,
not a download cap. PBP and qualified participation are not included. The source
document provides actual row counts, hashes and parsing commands.

Use decimal GB (`10^9` bytes), no compression savings, and the following
sensitivity assumptions. They are estimates to replace with #52 measurements:

| Assumption | Low | Expected | High |
| --- | ---: | ---: | ---: |
| Fraction of full-pass bytes/assets changed per poll, `f` | 0.25 | 0.5 | 1 |
| Average attempts/resource multiplier, `r` | 1 | 1.1 | 1.2 |
| Serialized selected observation/manifest allocation, `b` bytes/row | 512 | 1,024 | 2,048 |
| Physical DB multiplier, `m`, including heap/TOAST, indexes and bloat headroom | 1.6 | 2.5 | 4 |
| Seed normalized rows, `S` | 25,000 | 100,000 | 500,000 |
| Full-pass historical seed season-equivalents, `H` | 1 | 3 | 5 |
| Vercel active CPU seconds/batch | 1 | 3 | 10 |
| Vercel wall seconds/batch, at 2 GB | 10 | 30 | 90 |

`H=5` is an exploratory import sensitivity, not a change to the selected
three-season feature window. Older feed/schema availability must be checked;
these season-equivalents are not a promise that identical historical bundles
exist. No volume estimate qualifies strict historical timing.

Normalized records count a shared row once, not nine copies for nine markets.
They include retained source-row revisions, feature dependencies/quality,
identity/membership and capture/label manifests; distinct versions add rows.
Before implementation #52 must inventory the schema by table and include
participation, new features and any longer pinned retention. `b`/`m` are not
measured PostgreSQL row/index sizes or guaranteed upper bounds.

## Monthly workload and storage estimates

Use a 30-day active-season month. `d` = shared batches, `E` = distinct target
events, `k` = forecast checkpoints/event, `N` = new retained normalized rows
(including corrections), `Q` = feature/quality reads. Reads below are sizing
assumptions, not existing traffic or model execution. Development is local;
Vercel resource assumptions apply only to hosted profiles.

| Profile / scenario | `d` | `E` | `k` | `N` rows/month | `Q` reads/month | Assumed incremental Neon CU-h/month |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development low | 1 | 1 | 1 | 1,000 | 100 | N/A: local |
| Development expected | 4 | 4 | 2 | 5,000 | 1,000 | N/A: local |
| Development high | 8 | 16 | 4 | 20,000 | 10,000 | N/A: local |
| Free-pilot low | 4 | 1 | 2 | 10,000 | 1,000 | 4 |
| Free-pilot expected | 12 | 4 | 4 | 30,000 | 10,000 | 12 |
| Free-pilot high | 30 | 5 | 8 | 100,000 | 100,000 | 40 |
| Production low | 30 | 16 | 2 | 50,000 | 10,000 | 10 |
| Production expected | 120 | 64 | 4 | 150,000 | 100,000 | 40 |
| Production high | 360 | 80 | 8 | 500,000 | 1,000,000 | 200 |

```text
metadata attempts = 7 × d × r
asset attempts = 7 × d × f × r
download GB = 0.071 × d × f × r
optional forecast attempts = E × k × r
monthly physical DB growth GB = N × b × m / 10^9
monthly retained artifact growth GB = N × b / 10^9
seed physical DB GB = S × b × m / 10^9
seed artifact GB = 0.071 × H
36-month reference DB GB = seed DB + 36 × monthly DB growth
36-month reference artifacts GB = seed artifacts + 36 × artifact growth
```

Fractional request counts are expectation values; provision integer ceilings.
The hard retry ceiling is three attempts, not `r=1.2`: production-high can make
7,560 metadata attempts, download 76.68 GB and issue 1,920 forecast attempts if
every resource uses all attempts. Bound retries and stop rather than silently
spending through an outage. Bootstrap adds its own initial requests/bytes.
Optional forecasts remain hypothetical until each source gate passes.

| Profile / scenario | Metadata attempts | Asset attempts | Downloads GB | Optional forecast attempts | DB growth GB/month | Artifact growth GB/month |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development low | 7 | 1.75 | 0.01775 | 1 | 0.0008192 | 0.000512 |
| Development expected | 30.8 | 15.4 | 0.1562 | 8.8 | 0.0128 | 0.00512 |
| Development high | 67.2 | 67.2 | 0.6816 | 76.8 | 0.16384 | 0.04096 |
| Free-pilot low | 28 | 7 | 0.071 | 2 | 0.008192 | 0.00512 |
| Free-pilot expected | 92.4 | 46.2 | 0.4686 | 17.6 | 0.0768 | 0.03072 |
| Free-pilot high | 252 | 252 | 2.556 | 48 | 0.8192 | 0.2048 |
| Production low | 210 | 52.5 | 0.5325 | 32 | 0.04096 | 0.0256 |
| Production expected | 924 | 462 | 4.686 | 281.6 | 0.384 | 0.1536 |
| Production high | 3,024 | 3,024 | 30.672 | 768 | 4.096 | 1.024 |

Constant growth for 36 months is a conservative retention sensitivity, not an
NFL seasonal forecast. Actual growth varies with game calendar and changed rows.
Expected development/pilot/production reference DB sizes are 0.717/3.021/14.080
GB, with 0.397/1.319/5.743 GB of artifacts. Production low/high DB sizes are
1.495/151.552 GB; artifacts 0.993/37.219 GB. These exclude existing app tables,
extra pinned manifests, backup/restore history, replication and staging peaks.

For the expected production example, `150,000 × 1,024 × 2.5 / 10^9 = 0.384`
GB/month. Its initial DB seed is 0.256 GB; first-month average, assuming linear
growth, is `0.256 + 0.384/2 = 0.448` GB. Its artifact average is
`0.213 + 0.1536/2 = 0.2898` GB. Downloads (4.686 GB) are not retained growth
(0.1536 GB); diffing reduces storage while repeated changed files still cost
bandwidth and parsing.

## Public rates and complete cost accounting

Rates are USD before tax, checked on the date above; no private plan/headroom
or invoices were inspected. Recheck at #52 intake and before activation. The
native [Neon pricing](https://neon.com/pricing) and
[usage metrics](https://neon.com/docs/introduction/usage-metrics) were retrieved
as Markdown; older blog allowances can differ. Marketplace entitlements may
differ from these public plans and require owner confirmation.

| Cost component | Public reference / model | Boundary |
| --- | --- | --- |
| New selected data-provider fees | $0 for selected public nflverse research feeds; qualified public NWS/NOAA/MET alternatives also have no provider fee | Rate limits, rights and gates still apply. Existing Odds API/hosting bills are separate; paid alternatives remain deferred. |
| Source download bandwidth | GB table above; no source download charge established for these public samples | Include local ISP allowance and hosting external-network treatment. Do not price GitHub-to-function fetches as CDN-to-user bytes automatically. |
| Vercel Functions, illustrative `iad1` Fluid | $0.128/active CPU-h; $0.0106/provisioned GB-h; $0.60/million invocations | Waiting excludes active CPU but consumes provisioned memory. Configuration/region and actual durations remain unmeasured. |
| Vercel CDN, on-demand `iad1` reference | $0.15/GB Fast Data Transfer; $0.06/GB Fast Origin Transfer; $2/million CDN requests | Only eligible request/response traffic. Flat Rate CDN is a different billing mode; confirm team setting rather than charging both. |
| Vercel scheduler / platform | Cron itself included; Pro platform $20/month includes one deploying seat and $20 usage credit | Existing fee/credit may be shared or exhausted. More-frequent-than-daily cron requires Pro; Hobby is personal/non-commercial. No plan upgrade authorized. |
| Neon database storage / compute | Launch $0.35/GB-month and $0.106/CU-h; Scale $0.222/CU-h | Includes data/index physical allocation estimate above. Compute is active endpoint time × CU, not query milliseconds alone. |
| Neon network | Public egress: 5 GB/project/month Free; 500 GB paid, then $0.10/GB | Include query results, artifact downloads and exports; counters are shared. Public inbound SQL writes are not outgoing query traffic. |
| Private artifact store, sizing option | Neon Object Storage $0.023/GB-month, no per-operation fee; public egress shares its allowance | Conditional hosting option, not selected/provisioned infrastructure. Owner/#52 must confirm availability through the existing Vercel integration, private access, retention and restore. If unavailable, price another approved store before proceeding. |
| Recovery / branches | Neon instant-restore history $0.20/GB-month; snapshots $0.09/GB-month; extra branches $1.50/branch-month | Add actual retained sizes/branch lifetimes. Application revision retention is separate from platform restore history. |

Primary references: [Fluid billing](https://vercel.com/docs/functions/usage-and-pricing),
[regional rates](https://vercel.com/docs/pricing/regional-pricing/iad1),
[CDN definitions](https://vercel.com/docs/manage-cdn-usage),
[Pro fee/credit](https://vercel.com/docs/plans/pro-plan),
[Flat Rate CDN](https://vercel.com/docs/pricing/flat-rate-cdn),
[cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing),
[Hobby terms](https://vercel.com/docs/plans/hobby), and
[Neon network measurement](https://neon.com/docs/introduction/network-transfer).

For arithmetic only, assume each read costs 0.005 active CPU seconds, 0.05 wall
seconds at 2 GB, and a 4,096-byte response; cron responses are 1,024 bytes.
Apply `r` to read/batch attempts too. This deliberately prices all eligible CDN
bytes on demand without subtracting allowances/credit; it is a usage valuation,
not the invoice prediction. These read timings, forecast overhead within batch
time, and network/body sizes all require measurement.

```text
J = (d + Q) × r
CPUh = (d × batch_CPU_seconds + Q × 0.005) × r / 3,600
MEMh = 2 × (d × batch_wall_seconds + Q × 0.05) × r / 3,600
CDN_GB = (d × 1,024 + Q × 4,096) × r / 10^9
Vercel usage valuation = CPUh × 0.128 + MEMh × 0.0106
                       + J × (0.60 + 2) / 10^6 + CDN_GB × (0.15 + 0.06)
Neon compute valuation = incremental CUh × 0.106
DB valuation = average added physical GB × 0.35
artifact valuation = average added artifact GB × 0.023
```

Monthly compute assumptions (4/12/40 pilot and 10/40/200 production CU-h)
include ingestion, revision checks, joins, index maintenance, feature/quality
reads and wake-to-suspend tails. They are budget sensitivities, not benchmarks
inferred from row counts. At 0.25 CU, 120 isolated wakeups with a five-minute
idle tail alone add up to 2.5 CU-h; overlapping existing traffic may add less,
while larger autoscaled endpoints or prevented suspension may add much more.
An always-on 1-CU endpoint is 720 CU-h in this 30-day month ($76.32 Launch).
Measure incremental usage against an idle/control window; do not promise that
every query's apparent runtime is its billed CU time.

| Hosted profile / scenario | CPU-h | Memory GB-h | Vercel usage valuation | First-month core usage valuation | 36-month reference core usage valuation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Free-pilot low | 0.003 | 0.050 | $0.004 | $0.44 | $0.54 |
| Free-pilot expected | 0.026 | 0.526 | $0.047 | $1.43 | $2.41 |
| Free-pilot high | 0.267 | 5.133 | $0.504 | $6.33 | $16.68 |
| Production low | 0.022 | 0.444 | $0.042 | $1.12 | $1.65 |
| Production expected | 0.263 | 5.256 | $0.470 | $4.87 | $9.77 |
| Production high | 2.867 | 54.933 | $5.103 | $28.47 | $80.20 |

Core valuations sum the four formula categories; first-month storage is seed
plus half of that month's linear growth, while the retention reference holds
the estimated accumulated storage for a full billing month. **These are partial
priced components, not all-in budgets.** Add platform fee only if newly needed;
subtract only genuinely available allowances/credit; then add measured external
network charges, history/snapshots/branches, pinned retention and other costs.
Scale compute substitutes `CUh × 0.222`; it does not share Launch's rate.
Taxes, model training/inference, creator/LLM work, support labor and existing
Odds API/collector traffic are outside these ingestion valuations.

Development uses existing local compute/disk, with $0 new provider fees and no
new cloud-service charge in the selected local profile. Disk/power/ISP and
engineering time are not priced; this is not an all-in $0 claim. Local monthly
physical growth is 0.0008192/0.0128/0.16384 GB plus artifact growth, with the seed
and retention estimates above. A cloud development deployment would need its
own plan and the same metering formulas rather than inheriting a local $0.

The public Neon Free reference currently lists 1 GB Postgres storage/project,
100 CU-h/project/month and 5 GB Object Storage/project. Owner confirmation is
required for the Vercel-connected resource. The expected pilot alone accumulates
about 1.178 GB DB after 12 constant-growth months (`0.256 + 12 × 0.0768`), before
existing tables. The high pilot seed already exceeds 1 GB. Free-pilot may fit a
short bounded capture test, but does not promise free long-term retention.
Do not silently shorten provenance or drop zero outcomes to fit an allowance.

For expected production, eligible query egress is about 0.451 GB/month before
artifact retrievals/exports/overhead; high is 4.915 GB. Add those other bytes to
the shared Neon counter, then apply the verified allowance and $0.10/GB rate
where applicable. Object PUT/GET counts should be recorded even when the
reference store has no per-operation fee. No external traffic is assumed free
solely because eligible CDN responses are small.

## Initial import and excluded acquisition budgets

Bootstrap is a separately approved bounded operation; it does not run inside
every recurring poll. The 1/3/5 season-equivalent scenarios add 0.071/0.213/0.355
GB of full-pass downloads, about 7/21/35 metadata and asset requests before
retries, and 25,000/100,000/500,000 seed normalized rows. Player-stat-only evidence
for five actual 2021–2025 files is about 42.3 MB; broader historical bundle sizes
are unmeasured. Historic injury/depth schemas and rights need per-feed checks.

The seed DB allocations are 0.02048/0.256/4.096 GB; artifact bases are
0.071/0.213/0.355 GB. Their ongoing Launch storage valuations are
$0.0072/$0.0896/$1.4336 per month plus $0.0016/$0.0049/$0.0082 for artifact bases.
Those seeds are already included in the monthly cost table; do not add them
again when valuing recurring storage.

For an unmeasured cloud import sensitivity, assume 30/120/600 active CPU seconds,
60/300/1,800 wall seconds at 2 GB, and Neon endpoint sizes 0.25/1/4 CU with one
five-minute tail. Vercel CPU+memory valuation is about
$0.0014/$0.0060/$0.0319; Neon import compute is 0.025/0.1667/2.3333 CU-h, about
$0.0027/$0.0177/$0.2473. Add invocations, network, retries and checkpoints.
Do not execute a 1,800-second import as one serverless invocation: bound/chunk it
or run an approved local worker, then measure extra wakeups and overhead.
Check [function limits](https://vercel.com/docs/functions/limitations) for the
actual configuration. These values are arithmetic examples, not import timing
or a tested execution architecture.

Optional PBP research, a qualified participation ledger, official reconciliation,
NOAA/GFS archives and authenticated injury alternatives remain separate cost
gates. For each, measure downloaded bytes `D`, retained base bytes `A`, new
version rows `N`, parser/decoder CPU+wall time, DB index/compute and request
counts; substitute them into these formulas and add to the profile. Annual PBP
or global grids must not be treated as a 71-MB bundle or a venue-only JSON call.
No default workload estimate proves these omitted routes affordable or ready.
The population-blocker remains open until a qualified ledger's implementation
and complete budget are approved; this document does not hide it in a $0 feed.

## Measurements and recheck triggers

The [#52 bounded source prototype](predictive-source-prototype.md) records a local current-season capture under 28-request/20-MB/90-second ceilings, exact-byte offline verification, independent count parity and measured local storage/runtime/RSS. Its depth capture is incomplete, all QB participation remains unresolved and no real feature publication occurs. It supplies local sample evidence only; the hosting, population, rights and all-in cost gates below remain open.

#52 must record a bounded local prototype and then an owner-approved hosted
pilot before production activation: exact endpoints/sizes, changed-row rate,
capture coverage/gaps, schema row/TOAST/index bytes, dependency/label/participation
counts, replay restoration, processing CPU/wall/RSS, retries and query plans.
Measure compute wake/tail and baseline-vs-pilot CU-h, artifact operations/egress,
CDN/external-network meters, storage peaks and daily/weekly growth. The owner
provides plan/region/billing-mode/allowance/headroom evidence without credentials.
Agent production Vercel/Neon access requires separate express authorization.

Require a complete measured cost sheet including all previously unpriced
components, an approved request/byte/runtime/storage/spend ceiling and the
behavior at that ceiling. Stop acquisition and surface missingness when a
budget fails; never erase required provenance as an automatic cost control.

Recheck upstream schema/units/identifiers/license notices on every parser/feed
change, each new season and at least monthly during acquisition. Recheck rights
before every new public/commercial output, retention/redistribution change or
PFR/FTN integration. Recheck pricing/plan settings at activation, on a rate
change and monthly against usage. Revisit a paid option only when a measured
coverage gap persists and a sample demonstrates earlier availability, complete
participation/status semantics, correction lineage, licensed retention/output
rights and total incremental cost. A paid invoice alone cannot qualify history.

## Downstream handoff and closure evidence

| Owner | Required implementation or validation handoff |
| --- | --- |
| [#60 migrations](https://github.com/ven2dev/dfs-ev-demo/issues/60) | Establish ordered migrations/ledger and empty/upgrade/idempotency checks using #45's disposable Postgres harness before #52 introduces persistent structures. Production execution remains explicitly approved. |
| [#52 ingestion](https://github.com/ven2dev/dfs-ev-demo/issues/52) | [Seven-group column allowlists](#exact-raw-column-allowlists) and conditional acquisition; GSIS, `nfl:team:<seed abbreviation>` and internal UUID game bridges; versioned availability/capture/ingestion, completed-event evidence, append-only corrections, replay, participation-ledger qualification and canonical label finalization. Qualify the post-inactives checkpoint separately from routine injury/depth capture. Honor market/position registry, paid/rights gates, profile caps, missingness and ordered feature fallbacks. Measure the full cost sheet before activation. |
| [#54 model](https://github.com/ven2dev/dfs-ev-demo/issues/54) | All nine prospective predictor dispositions plus blocked population coverage; nine named stats candidates, separate optional enriched candidates, strict/exploratory history distinction, independent-feature exclusions and per-market sufficiency. Conditional-on-participation `overProbability`, `underProbability`, `pushProbability` sum to one; push is equality, separate from void/DNP. Fair-price/EV and metrics must explicitly handle push and settlement differences. |
| [#53 product](https://github.com/ven2dev/dfs-ev-demo/issues/53) | No serving/display permission by implication. Integrate only validated versions with visible cutoff, quality, missingness, uncertainty and fallback identity after rights gates pass. Keep interim heuristic and market/creator comparisons identifiable. |

#54's live issue was amended and read back exactly on 2026-10-05. The update
replaces universal two-way complementarity in model/service, acceptance and
test instructions, adds push-aware scoring and fair-price semantics, and keeps
population/cutoff gates explicit. Description, non-goals and dependencies were
preserved. The [exact before/after diff and saved-body verification](https://github.com/ven2dev/dfs-ev-demo/issues/49#issuecomment-6005093402)
are recorded on #49 as closure evidence; a handoff paragraph alone is
insufficient. #49 stays open until the approved documentation PR merges; the
final PR uses `Closes #49`.

| #49 acceptance criterion | Decision/evidence |
| --- | --- |
| 1. Matrix covers usage, injury, defense, pace/environment, schedule and outcomes | [Source matrix](predictive-data-sources.md#source-matrix), including PBP pace research, weekly rosters and official outcome benchmark |
| 2. Fields/IDs/history/latency/corrections/limits/cost/rights/reliability per candidate | [Qualification and access/rights](predictive-data-sources.md#access-rate-limits-cost-and-rights), reproducible samples and this complete cost accounting |
| 3. Per-market MVP features/rationale; unsupported inputs explicit | [Nine readiness rows](predictive-feature-contract.md#per-market-data-readiness), minimum/optional tables; prospective predictors and blocked participation coverage distinguished |
| 4. As-of capability and no-look-ahead risks | [Cutoff/provenance envelope](predictive-feature-contract.md#cutoff-provenance-and-correction-envelope), archive/decoder gates and strict-versus-exploratory schedule limit |
| 5. Event/player/team/market identity mapping | [Concrete identity contract](predictive-feature-contract.md#player-team-and-event-identity), registry capability boundary and worked examples |
| 6. Development/production monthly API/storage costs | Operating profiles, monthly workload, seed-versus-growth formulas, all cost categories and measurement/activation gates in this document |
| 7. Missing/delayed/corrected/conflicting fallback policy | [Response contract](predictive-feature-contract.md#missingness-and-response-contract), ordered feature alternatives and operational freshness/degradation table |
| 8. User display versus internal use | [Source-use rights](predictive-data-sources.md#access-rate-limits-cost-and-rights) and final dispositions: research selected, public/commercial core display conditional, bulk redistribution unavailable |

Closure records documented decisions and unresolved qualifications. It does not
claim that capture jobs, complete labels, public rights, calibrated projections
or a new provider have shipped.
