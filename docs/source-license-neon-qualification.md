# #171 read-only qualification record

Research date: October 18, 2026 (Pacific); observed at 2026-10-19T04:11:51Z. Original research base: `3b9d946`. This document now delivers that snapshot plus explicitly dated follow-up observations. At that original snapshot, no hosted connection, hosted write, Production command, upstream message, provider call or new raw-data download had occurred. Later owner-authorized catalog reads are recorded separately below; they are not counted as original #171 research.

## Verdict

All 16 inputs are accounted for against #138's **actual ingestion manifest**, not just its earlier inventory. All 16 published licence declarations are now verified for the exact release inputs. The schedule release-use scope is qualified under the first-party clarification recorded below; direct upstream nfldata licensing remains unresolved. This record does not authorize redistribution, commercial deployment, model evaluation or #54 population-completeness claims. A later console-role timeout observation is recorded below; the intended pipeline connection configuration remains unverified.

## Design basis

Pattern: evidence-backed source qualification with separate declaration, operational-configuration and deployment-permission states. Alternatives rejected: treating the loader's software license as a data grant; treating a provider default as an observation of the project's configuration. Targets: 16/16 file records, explicit schedule/Neon blocked states, zero hosted writes and zero Production commands. Pins bind the policy reviewed; separate historical flags prevent look-ahead claims. No hot path, ingestion or database subsystem is being implemented, so this research has no performance spike.

## File qualification

| Input | Published declaration | Verdict |
|---|---|---|
| games.csv.gz | CC-BY-4.0 | Release use qualified with attribution; direct upstream repository excluded |
| pbp_participation_2021.csv | CC-BY-SA-4.0 | Declaration verified; obligations apply |
| pbp_participation_2022.csv | CC-BY-SA-4.0 | Declaration verified; obligations apply |
| pbp_participation_2023.csv | CC-BY-SA-4.0 | Declaration verified; obligations apply |
| pbp_participation_2024.csv | CC-BY-SA-4.0 | Declaration verified; obligations apply |
| pbp_participation_2025.csv | CC-BY-SA-4.0 | Declaration verified; obligations apply |
| roster_weekly_2021.csv | CC-BY-4.0 | Declaration verified; obligations apply |
| roster_weekly_2022.csv | CC-BY-4.0 | Declaration verified; obligations apply |
| roster_weekly_2023.csv | CC-BY-4.0 | Declaration verified; obligations apply |
| roster_weekly_2024.csv.gz | CC-BY-4.0 | Declaration verified; obligations apply |
| roster_weekly_2025.csv.gz | CC-BY-4.0 | Declaration verified; obligations apply |
| stats_player_week_2021.csv.gz | CC-BY-4.0 | Declaration verified; obligations apply |
| stats_player_week_2022.csv.gz | CC-BY-4.0 | Declaration verified; obligations apply |
| stats_player_week_2023.csv.gz | CC-BY-4.0 | Declaration verified; obligations apply |
| stats_player_week_2024.csv.gz | CC-BY-4.0 | Declaration verified; obligations apply |
| stats_player_week_2025.csv.gz | CC-BY-4.0 | Declaration verified; obligations apply |

Exact input hashes, attribution parties and immutable policy links are preserved in [the receipt](evidence/feature-store-171/qualification-receipt.json). The original inventory schedule hash `6983084aff35e6ea9228440cfb5bba70b23625b9b2799eaff5b03eb808f1498e` differs from the ingestion snapshot `962ea33bc96c7b5d298c28b5d8d8b64309ee2ddb450806bf3634fd10c0386dbd`; that known change is retained, not silently collapsed into one identity. No input bytes were reread or republished here.

## Permission evidence and obligations

The [pinned nflverse-data license](https://github.com/nflverse/nflverse-data/blob/a78da18ca93f167bd0a2af274df48f539fa4153c/LICENSE.md) declares CC BY 4.0 for the release repository. Stats and rosters preserve nflverse contributor credit, source/license references and modification notices. This is a declaration finding, not independent proof of every underlying right.

The [pinned participation documentation](https://github.com/nflverse/nflreadr/blob/23f915a5be30415aeaa0c5c80cd23b2c69cda122/R/load_participation.R) specifies CC BY-SA 4.0. Credit NFL NextGenStats through nflverse for 2021–2022, and FTN Data through nflverse for 2023–2025. Preserve the feed-specific attribution and assess the ShareAlike obligation for distributed adapted data separately; the release root does not erase that obligation. No claim is made that a particular model artifact or commercial product is legally cleared.

The official [CC BY terms](https://creativecommons.org/licenses/by/4.0/) and [CC BY-SA terms](https://creativecommons.org/licenses/by-sa/4.0/) explain credit, license references, modification notices and the latter's ShareAlike conditions. This research adds no attribution trailers to Git; source attribution obligations concern the data and any authorized distribution.

The schedule's upstream [licence request #33](https://github.com/nflverse/nfldata/issues/33) remains open, and [commercial clarification #35](https://github.com/nflverse/nfldata/issues/35) was closed without a grant. Neither issue establishes permission. However, the [nflverse organization clarification pinned to 74a492c](https://github.com/nflverse/.github/blob/74a492cc87123142279c83d2d543e822e81a879c/profile/README.md#licensing), published October 13, 2026, explicitly scopes CC BY 4.0 to nflverse-data release datasets except FTN data and permits commercial use with attribution. The initial research missed this already-published first-party evidence. The current [schedule release](https://github.com/nflverse/nflverse-data/releases/tag/schedules) identifies the artifact and upstream maintainer and publishes no contrary licence exception. This qualifies the release-use scope of the ingested games.csv.gz; it does not supply a licence for separate direct nfldata downloads or warrant all third-party rights. No contact was sent.

The 2023-onward participation documentation describes post-season publication; it does not demonstrate availability before historical games. Retain `historical-availability-unverified`. The recorded 2,504 player-games and dataset hash `a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d` are existing #138 evidence, not freshly reproduced here. Identity and participation gaps remain outside a population-completeness claim.

## Neon configuration qualification

[PostgreSQL 18 documentation](https://www.postgresql.org/docs/18/runtime-config-client.html) documents statement_timeout = 0 by default, disabling that timeout. [Neon's compatibility documentation](https://neon.com/docs/reference/compatibility) lists explicit parameter overrides but does not list statement_timeout. The reviewed Neon pages do not explicitly guarantee that value across every account, role, database, connection or driver. Therefore: Postgres default verified; provider-wide guarantee not inferred; **actual project configuration blocked**.

[Neon's pooling documentation](https://neon.com/docs/connect/connection-pooling) warns that transaction pooling does not preserve arbitrary session SET state. A future authorized read should capture the value on the intended pipeline role/connection mode, not infer it from a SQL Editor session or a different role.

Only after the owner designates a non-production read-only target, inspect with SHOW statement_timeout and SELECT name, setting, unit, boot_val, reset_val, source, pending_restart FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout'). Capture the approved target identity and role without credentials. No ALTER, migrations, test writes, SET changes or Production probes are part of this read-only step. Do not discover or reuse credentials from local environment files or connector inventory.

## Follow-up roadmap and AC disposition

1. Research complete: preserve the 16-file manifest, pinned policy references, attribution/modification duties, ShareAlike distinction and scoped schedule release-use finding in this receipt.
2. Research complete with a qualification limit: separate Postgres documented defaults and Neon documented override/pooling behavior from actual account settings. Actual settings remain blocked.
3. Schedule release-use evidence established on October 20: retain nflverse and Lee Sharpe attribution, source/licence references and modification notices. Direct upstream repository licensing remains unresolved and outside this qualified scope; unanswered issue closure is not permission.
4. Owner decision pending: designated non-production read-only connection, if actual settings are wanted. Otherwise retain blocked status.
5. Repository documentation delivery is prepared on feature/dfsEV-171-source-license-record, with commit and push still subject to owner approval. Issue closure is assessed against the qualification-record ACs; dataset/public-serving approval remains a separate downstream decision.

## Monorepo and access review — October 19, 2026

The original research date and base SHA above remain the evidence snapshot. The receipt still parses, contains 16 file records and its relative documentation link resolves after #148. This review did not re-fetch source policies or reread raw datasets, so it does not claim a new licence verification date. Vercel Storage now visibly identifies a separate `dfs-ev-preview` resource connected to Preview, alongside a Production resource. Direct Neon login is blocked by #86. No Preview branch/role has yet been designated for #171 read-only configuration capture; that actual-settings gate remains unresolved. Discovery of a dashboard resource alone does not substitute for that designation.

## Authorized console observation — October 19, 2026

During the separately authorized Preview/Production catalog comparison, Vercel's read-only Query editor reported statement_timeout = 0 for neondb_owner on both resources, PostgreSQL 18.6 (653b019). This is an actual console-connection observation, not a provider-wide default guarantee or evidence of the pipeline role/driver connection's effective setting. The intended pipeline connection capture remains unresolved. See the receipt followUp.hostedCatalogObservation; no hosted write occurred. This supersedes the earlier statement that no hosted reads had occurred as of the original research snapshot, while preserving that snapshot's date and receipt unchanged.

## Schedule replacement assessment

Recommendation: evaluate replacement before requesting maintainer permission, but **do not switch to the PBP date field as a presumed independent source**. The [pinned PBP dictionary](https://github.com/nflverse/nflreadr/blob/23f915a5be30415aeaa0c5c80cd23b2c69cda122/data-raw/dictionary_pbp.csv) documents game_date and start_time (Eastern). The [pinned PBP release repository](https://github.com/nflverse/nflverse-pbp/blob/cd7bfd9bbf9251529bf5e0283ae84f10e11e7d17/LICENSE.md) declares CC BY 4.0. Those findings alone do not establish independent provenance.

The current [pinned producer helper](https://github.com/nflverse/nflfastR/blob/701bbf38bc1c030ff9f1f4825a23191287d3903c/R/helper_add_game_data.R) loads nflreadr::load_schedules(), joins its game data, and sets game_date from gameday. The [raw NFL parser](https://github.com/nflverse/nflfastR/blob/701bbf38bc1c030ff9f1f4825a23191287d3903c/R/helper_scrape_nfl.R) obtains start_time from the raw game-detail startTime field, but exact historical release provenance, completeness and underlying rights were not established. This is a current-source code inspection, not proof that every 2021–2025 artifact used the identical producer version.

A qualified replacement needs independent authorized provenance for every required game identifier/date/kickoff field, one consistent timestamp per game, timezone/DST and postponed-game handling, 2021–2025 coverage against the bounded research population, and immutable source/input hashes. Historical postgame PBP also does not provide future schedule availability or prove pregame knowledge. No raw release was downloaded, new dataset ingested, pipeline code changed or maintainer contacted. This replacement candidate remains unqualified as independent provenance. The subsequent first-party release clarification below makes replacement unnecessary for the documented release-use scope; it does not rewrite the existing input snapshot.

## Public-serving and operational gates

[ShareAlike decision #197](https://github.com/ven2dev/dfs-ev-demo/issues/197) tracks the owner-approved disposition before participation-derived features are served publicly. It covers per-output lineage, applicable notices/ShareAlike review and an explicit Phase 10 release prerequisite. This record does not clear those outputs.

The observed console-role statement_timeout of 0 means that server setting does not impose a statement-duration limit on that connection. It does not prove that no other timeout/cancellation exists. Assess per-role app/pipeline limits in #190 or #95; neither this research nor the catalog comparison changes those settings. Vercel Query unblocks bounded read-only snapshot/plan investigation for #95; restore and branch drills remain subject to #86 access.

## Schedule release-use resolution — October 20, 2026

**Decision basis:** retain the exact ingested nflverse-data release artifact, under the publisher's explicit CC BY 4.0 release scope, rather than replace it with a field copied from the same schedule source or send a redundant permission request. The publisher offers no warranty of underlying rights; this is a scoped source qualification, not a legal guarantee or general product release approval.

**Scope:** research storage/normalization, derived analysis and commercial reuse of the release-distributed schedule under CC BY 4.0, subject to its terms. Preserve credit to nflverse and Lee Sharpe, source/release link, licence link and notices of normalization, Eastern-to-UTC conversion, filtering and other modifications. Do not imply endorsement. Do not extend this finding to direct nfldata downloads, betting-line provenance, unrelated fields or participation/FTN obligations without their own assessment.

**Input identity:** retain ingestion wire SHA-256 962ea33bc96c7b5d298c28b5d8d8b64309ee2ddb450806bf3634fd10c0386dbd and the earlier inventory hash as distinct recorded identities. The release asset is mutable: metadata observed October 20 reports a different current games.csv.gz digest (8d272f16ceae09e30cc533c47b39bab5929bcd1b1764db9d520829af25187c4d). No new raw bytes were downloaded or substituted. The publisher's dataset-level statement scopes the release generally; it is not an individual hash-specific attestation.

**Boundaries:** #197 still governs public participation-derived outputs; #54 still owns population completeness; pipeline-role settings remain unverified. No pipeline code, rights registry, data distribution or hosted configuration changed. The record can clear the schedule release-declaration gap without claiming those separate gates passed.

## Participation / ShareAlike assessment — October 20, 2026

### Licence scope and interpretation

The [pinned participation loader](https://github.com/nflverse/nflreadr/blob/23f915a5be30415aeaa0c5c80cd23b2c69cda122/R/load_participation.R) explicitly assigns CC BY-SA 4.0 and separate provider attribution: NFL NextGenStats via nflverse for 2021–2022; FTN Data via nflverse for 2023–2025. Retain this specific declaration for all five ingested files rather than silently applying the organization's broader non-FTN CC BY summary to the earlier years. The year-specific scope discrepancy remains a review item, not permission to downgrade obligations.

[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en) permits commercial reuse. Sharing adapted material invokes ShareAlike and attribution; the database-rights provisions also matter. Applicable downstream rights cannot be restricted by additional terms or technical measures. This is not an automatic prohibition on charging for a service.

The [Creative Commons FAQ](https://creativecommons.org/faq/) distinguishes private reuse from public sharing and says CC licences do not compel publication of private work. Whether a particular output is an adaptation depends on applicable rights and law. Its software guidance does not support treating all surrounding application source as automatically covered. That also does not automatically exempt a model or prediction.

The [publisher's organizational explanation](https://github.com/nflverse/.github/blob/74a492cc87123142279c83d2d543e822e81a879c/profile/README.md#licensing) describes FTN-derived models/applications broadly as subject to ShareAlike/open availability. Preserve that stricter published interpretation alongside the legal terms; do not promise proprietary public model serving on the strength of a narrower interpretation without an output-specific qualified decision. No legal clearance or alternate permission was obtained.

### Repository lineage inventory

Observed code at this branch's base `edb5981` (documentation follow-up only). These are technical dependencies, not legal determinations that every downstream object is Adapted Material.

| Output or boundary | Observed participation dependency | Proposed disposition for #197 |
|---|---|---|
| Five raw participation snapshots | Direct copies, with year-specific provider credit | Keep private research; assess terms/notices before any sharing |
| Normalized per-player/game offense_play_count | normalize.ts aggregates offensive players into counts | Treat proposed public export as participation-derived; licence/attribution review required |
| Eligible game histories and features | qb_job_context uses positive offense participation as an eligibility condition; derived.ts selects histories using that result | Hiding counts does not remove selection lineage; public use stays blocked |
| Outcome labels and dataset membership | Label context and dataset feature/label selection depend on qualified game context; dataset manifests retain snapshot lineage | Review the selected dataset as a whole, not only its numeric columns |
| Empirical support, probabilities and pricing | empiricalAdapter.ts reads the selected materialized history and emits research-scoped results | No automatic model-output exemption; public serving decision pending |
| Training/evaluation artifacts, model reports and published metrics using those datasets | Potential downstream dependency even without raw participation fields | Inventory each concrete artifact before release; do not infer all model artifacts share the same classification |
| Source code and unrelated product features | Reading data does not establish that the entire codebase is adapted data | Do not relicense the whole app by assertion; assess any embedded data and affected outputs separately |

Technical references: [normalization](../services/pipeline/src/featureStore/normalize.ts), [eligibility SQL](../packages/db/proposals/138_feature_store.sql), [feature/label materialization](../services/pipeline/src/featureStore/derived.ts), [dataset construction](../services/pipeline/src/featureStore/datasets.ts), [empirical adapter](../services/pipeline/src/featureStore/empiricalAdapter.ts). The current apps/web API source search found no featureStore/empiricalAdapter integration. That is a source-code observation, not an audit of a deployed service.

The adapter declares rightsScope=research and the dataset path checks research rights. Those existing checks are not a complete public-serving policy or a legal ShareAlike test. #197 still needs an explicit release prerequisite and verification in the future serving work.

### Recommended owner decision (not yet approved)

Keep the existing participation-dependent pipeline, datasets and empirical artifacts private/research-only. Before public use, choose an output-specific path in #197: comply with applicable ShareAlike terms for shared adapted material; obtain authoritative alternate permission; or build a separately qualified participation-free/replacement lineage and evaluate it afresh. The last option changes the eligibility/history policy, so it needs new versions, dataset hashes and validation; removing a field from a JSON response is insufficient. No source deletion or pipeline redesign is authorized here.

For a proposed shared artifact, record input snapshot IDs/years, classification and rationale, provider/source/licence credits, modification notices, adapter's licence when applicable, and compatibility of product terms/access controls with recipient rights. Paywall/login alone does not establish either compliance or noncompliance. Unresolved outputs remain excluded from public serving to prevent a research grant being reused as production permission.

#171 can complete this qualification record while #197 retains the public-serving decision. No source-code licence was changed, no data/model released, and no new claim about #54 population completeness was made.
