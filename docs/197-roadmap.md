# #197 participation-data release gate

Approved roadmap with a data-scoped notice disposition. Repository baseline is `origin/main`
at `977718b`. Read-only inspection covered the committed source, all tracked
paths on the pinned base, decompressed evidence archives and primary licensing
sources.

## Triage

#171 already records the owner's direction to comply with applicable ShareAlike
obligations for shared participation-derived outputs. #197 still needs an
output-specific disposition and a verifiable release gate. Relay's #169 timing
is independent of this document work. #173 remains the thin-slice verdict and
can cite #197 as a public-release dependency.

**First review surface.** The public repository already distributes a
normalized participation dataset in the #241 CI fixture. The payload includes
89,443 `norm_participation` rows with `player_id`, `game_id`,
`offense_play_count`, state and snapshot lineage. It also contains 18,762
feature rows and 18,762 label rows with their respective input graphs. Counts
below were computed by joining normalized rows to their snapshot's source
manifest and grouping by source season. The fixture embeds attribution and
license metadata in its source records. The sufficiency of that metadata, the
combined fixture's license and the applicability of database rights need
qualified review. The pinned tree has no standalone LICENSE or NOTICE file.

| Source season | Normalized participation rows | Publisher-designated credit |
| --- | ---: | --- |
| 2021 | 18,309 | NFL NextGenStats via nflverse |
| 2022 | 18,193 | NFL NextGenStats via nflverse |
| 2023 | 17,670 | FTN Data via nflverse |
| 2024 | 17,564 | FTN Data via nflverse |
| 2025 | 17,707 | FTN Data via nflverse |

[Public fixture manifest](https://github.com/ven2dev/dfs-ev-demo/blob/977718b0ac381e1a2aa892733278cdafe761932b/services/pipeline/tests/feature-store/fixtures/job-visibility-work-v1.manifest.json) · [CI fixture loader](https://github.com/ven2dev/dfs-ev-demo/blob/977718b0ac381e1a2aa892733278cdafe761932b/services/pipeline/tests/feature-store/job-visibility-work-fixture.ts) · [#244 replay pins](https://github.com/ven2dev/dfs-ev-demo/blob/977718b0ac381e1a2aa892733278cdafe761932b/services/pipeline/scripts/feature-store/replay-restore.ts)

**Product serving.** The inspected web source has no imports or references to
the governed pipeline predictor, prediction owner, empirical adapter or
participation tables. The current stream uses the interim `computeEV` path
with recent stats and sample coverage. This finding is limited to committed
source at the pinned SHA. The prospective #53 API/UI and #54 model outputs need
their own decisions. [Current stream](https://github.com/ven2dev/dfs-ev-demo/blob/977718b0ac381e1a2aa892733278cdafe761932b/apps/web/src/app/api/stream/route.ts) · [#53](https://github.com/ven2dev/dfs-ev-demo/issues/53) · [#54](https://github.com/ven2dev/dfs-ev-demo/issues/54)

## Design basis

- **Pattern.** Maintain a source-to-output disposition matrix and require
  affirmative approval for each public delivery channel. Keep legal
  classification separate from technical lineage and research authorization.
- **Alternatives.** A repository-wide license would conflate code and mixed
  data. Hiding participation columns would leave the selection dependency in
  histories, labels and forecasts. An API-only gate would miss public Git
  fixtures, downloads and evidence bundles.
- **Targets.** Give every identified affected output a disposition, owner and
  evidence reference. Release zero new participation-derived outputs while
  unresolved. Require a passing test of the approved gate before affected
  public serving. This documentation issue adds no hot path.
- **Requirement reasons.** Use exact snapshot and season lineage because
  attribution varies by provider. Review Git and downloads as release
  surfaces because application access controls cannot govern those copies.
  Refuse public output without explicit approval because the current research
  rights check has a narrower purpose.
- **Assumptions.** The 2021–2025 feed and the 16-file thin slice define the
  initial inventory. New sources, model versions, jurisdictions, distribution
  channels or recipient terms can require a fresh disposition. The owner
  approves release scope with qualified review where the rights analysis is
  unresolved.

The pinned feed documentation assigns CC BY-SA 4.0 and splits attribution at
2023. Preserve that feed-specific treatment alongside the broader nflverse
publisher statement, which discusses FTN-derived models and applications in
broader terms. For each shared item, review supplied credits, source and license
links, modification notices and prior notices. For items classified as
adaptations or involving applicable database rights, assess the adapter license
and recipient restrictions under sections 3 and 4. Technical dependence is an
input to qualified review. [Pinned loader](https://raw.githubusercontent.com/nflverse/nflreadr/23f915a5be30415aeaa0c5c80cd23b2c69cda122/R/load_participation.R) · [Publisher statement](https://github.com/nflverse/.github/blob/74a492cc87123142279c83d2d543e822e81a879c/profile/README.md#licensing) · [License terms](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en) · [#171 owner decision](https://github.com/ven2dev/dfs-ev-demo/blob/977718b0ac381e1a2aa892733278cdafe761932b/docs/source-license-neon-qualification.md#owner-approved-direction--october-20-2026)

## Initial output inventory

| Surface | Participation dependency | Intake disposition |
| --- | --- | --- |
| Raw participation assets | Five feed files and exact wire hashes are pinned by #138/#171 | Research retention. Assess any redistribution separately. |
| Public #241 fixture and its copies | Direct normalized counts plus mixed-source features, labels and lineage | Existing public distribution. Prioritize review of fixture-specific notices, applicable license and copies in history or other channels. |
| Normalized downloads, histories, labels and dataset rows | `normalize.ts` counts offensive plays. #241 SQL uses positive offensive participation for eligibility, affecting histories and outcome membership. | Hold new distribution pending artifact-specific assessment. Review the whole selected dataset and accompanying metadata. |
| Local model descriptor, evaluation reports and benchmark evidence | Model/evaluation flows consume selected datasets. #164 receipt lists ObjectStore report references and metrics. One #167 benchmark bundle contains request, timing/work and publication records. | Audit remaining public bundles separately by payload. Review descriptor, full reports, aggregate metrics and row-level examples as distinct outputs. |
| Future #53 API/UI and #54 model | The local predictor emits forecasts, sample size, model identity and feature snapshot IDs derived through governed history. Future fair price, edge and playable-boundary fields can inherit that dependency. | Gate affected fields and fallbacks before serving. Market-only inputs and other independently sourced outputs need their own lineage assessment. |

The current predictor authorizes research at Q1/Q2. A future product gate needs
an approved output contract in addition to that authorization. Hiding a card
alone leaves its API response and alternate channels exposed. The public-serving
test matrix should cover missing or withdrawn approval, mixed lineage, stale
approvals, responses and fallbacks, downloads and published artifacts. An
independently sourced control should remain eligible under its own approvals.
[Eligibility SQL](https://github.com/ven2dev/dfs-ev-demo/blob/977718b0ac381e1a2aa892733278cdafe761932b/packages/db/proposals/241_job_visibility.sql#L135) · [Composite research authorization](https://github.com/ven2dev/dfs-ev-demo/blob/977718b0ac381e1a2aa892733278cdafe761932b/packages/db/proposals/231_composite_authorization.sql#L202) · [Local prediction boundary](https://github.com/ven2dev/dfs-ev-demo/blob/977718b0ac381e1a2aa892733278cdafe761932b/docs/feature-store-local-predictions.md)

## Combined fixture source dispositions

| Feed | Seasons | Declared source terms and credit | Draft disposition |
| --- | --- | --- | --- |
| Schedules | 2021–2025 rows in one release file | CC BY 4.0, nflverse and Lee Sharpe. [Pinned release policy](https://github.com/nflverse/nflverse-data/blob/ab1331c85fd222ce953fe61363b099c0629de0a1/LICENSE.md) | Preserve release-file provenance and credit, and describe filtering and Eastern-to-UTC conversion. The qualification covers the nflverse-data release copy. |
| Weekly rosters | 2021–2025 | CC BY 4.0, nflverse and roster data contributors. [Pinned weekly rosters release license](https://github.com/nflverse/nflverse-data/blob/1709b7a448c464dade95669c2c85082a673da180/LICENSE.md) | Preserve credit and mark identity selection, week alignment and joins. Retain the upstream license designation. |
| Weekly player stats | 2021–2025 | CC BY 4.0, nflverse and player-stats contributors. [Pinned player stats release license](https://github.com/nflverse/nflverse-data/blob/0170a83ddb947bd82ddf66e78b4d9f0889f6c195/LICENSE.md) | Preserve credit and mark QB selection, normalization and joins. Retain the upstream license designation. |
| Participation | 2021–2025 | CC BY-SA 4.0, NFL NextGenStats via nflverse for 2021–2022 and FTN Data via nflverse for 2023–2025. [Pinned feed declaration](https://raw.githubusercontent.com/nflverse/nflreadr/23f915a5be30415aeaa0c5c80cd23b2c69cda122/R/load_participation.R) | Apply the owner-approved CC BY-SA 4.0 notice to the listed data, with qualified review to follow. Mark the per-player/game offensive-play aggregation and joins. |

## Checkpoint 1 · Add the data-scoped notices

The owner approved option 2 on **2026-11-09**. Add the visible, data-scoped
notices under #171's compliance direction. Qualified review follows and may
revise the wording. The current approval covers the notice for the listed
fixture and diagnostic excerpts. Future product delivery follows checkpoint 2.

The [fixture notice](../services/pipeline/tests/feature-store/fixtures/NOTICE.participation.md)
records the season-specific credits, fixed upstream license sources and
transformations. The [evidence notice](evidence/feature-store-138/NOTICE.participation.md)
lists the five JSON evidence files and two linked Markdown excerpts. The
[generated inventory](evidence/feature-store-197/tracked-payload-inventory.json)
records their pinned-main identities. The Markdown files gain links to the
notice. The pinned fixture, evidence payloads, manifests and replay inputs
retain their original bytes and hashes.

**Alternatives and cost**

- **Replace the fixture on main.** Stops future checkouts of the current tree
  from receiving the file and requires a replacement for the CI and replay
  paths, renewed parity evidence and a plan for controlled access if retaining
  the original privately. Earlier public commits still contain the file.
- **Rewrite public history.** Changes affected commit IDs, invalidates pinned
  references and requires coordinated force pushes and review. Copies already
  downloaded or retained elsewhere can persist. Past distribution remains a
  separate issue.

### Scan scope

The inventory starts from `git ls-files -z` in the clean pinned-main
worktree. Every tracked path was scanned. Gzip and tar members were
decompressed in memory. Structured JSON/JSONL was searched recursively for
player/game participation counts, row-level feature, label and related values,
and source diagnostics. Text examples with game/player identifiers were
reviewed separately. Counts are per tracked file, so repeated evidence
excerpts count in each copy. The evidence records hashes for all ten #241
full-records archives. The scan found no normalized participation, feature or
label row payloads in those archives. #244 verifies two archive member hashes
and reads the row graph from the separate fixture. Plans, timing records,
hashes, IDs without derived values and synthetic code examples are outside
the notice scope. History, forks, other branches, deployment assets and
external copies were outside this main-tree inventory.

## Checkpoint 2 · Record dispositions and gate #53

The owner approved the existing data notices in checkpoint 1. The current
disposition for prospective participation-derived outputs is **hold public
delivery pending an output-specific decision**. #171 supplies the owner's
direction to comply with applicable ShareAlike obligations. The release decision
still needs the actual output, its lineage and the proposed delivery terms.

| Output and channel | Technical lineage to qualify | Current disposition and handoff |
| --- | --- | --- |
| #241 CI fixture and listed #138 excerpts in public Git | Exact paths and source seasons in the inventory. The combined fixture includes participation, schedules, rosters and stats. | Owner-approved notice for the listed data. The owner retains the decision on wording changes after qualified review of the combined fixture and excerpts. |
| #53 analysis API and stream | Forecasts depend on offensive-participation eligibility in model inputs and history. Fair price, edge/EV and playable line and price inherit that dependency when calculated from the forecast. Sample counts, model identity and provenance are reviewed as separate response fields against their actual lineage. | Hold affected fields. #53 supplies the versioned response schema and tests the delivery gate, including streamed, cached and fallback responses. |
| #53 matchup cards, EV Tracker and evidence views | Check the lineage of forecasts and dependent values, participation or usage evidence, sample explanations, and edge history. Check source freshness and offer freshness separately. | Hold affected values and dependent summaries. #53 verifies the typed unavailable state, including direct API access and stale or invalidated results. |
| Downloadable histories, features, labels and analysis exports | Map exact rows, field definitions, eligibility, source snapshots and seasons. A field can inherit participation through row selection even if the count is absent. | Hold export. The export owner supplies the schema, audience, terms and artifact identity before requesting a decision. |
| #54 descriptors, fitted artifacts, evaluation reports and published evidence | Review training, evaluation and history inputs, plus the exact public artifact. Evaluate parameters, aggregate metrics and row-level excerpts separately. | Hold new affected artifacts. #54 or the publishing owner supplies the exact artifact, intended audience and delivery terms. |
| Market-only offers, exact-line consensus and independently sourced evidence or presentation | Trace inputs through delivery, including cache and fallback. Confirm independence from participation-derived values and selection. | Assess independently under its own approvals. #53's interim presentation slice can be considered separately if it meets that test. |

Use the exact source snapshot IDs and seasons for each proposed release. The
current evidence covers 2021–2025, with NFL NextGenStats via nflverse for
2021–2022 and FTN Data via nflverse for 2023–2025. The season range in this
roadmap identifies the research cohort. Each release record needs its actual
source subset and versioned lineage.

### Owner decision required before public delivery

For each output and channel, the delivery owner supplies a versioned field or
artifact list, exact lineage, audience and delivery terms. The qualified review
records applicability of attribution, modification notices, adaptation,
database rights and ShareAlike for that specific output. The owner then records
one disposition with the review reference:

- **Comply and release within the approved scope.** Record the required credit,
  source and license links, modification notices, and any applicable
  downstream license terms. Verify the delivered response or artifact carries
  the approved terms.
- **Omit the affected output.** Verify that dependent values and alternate
  delivery paths also respect the omission.
- **Replace the source.** Requalify the replacement and demonstrate that the
  delivered output and its model inputs no longer depend on the old source.
- **Obtain authoritative permission.** Record the grant and its scope before
  delivery. External maintainer contact requires separate owner authorization.

The [#53 public-serving roadmap addendum](53-public-serving-roadmap.md) defines
the prerequisite and test matrix. #53 owns implementation and passing
enforcement evidence before shipping affected outputs. #197 records the
dispositions and the gate design.

**LOE.** 1–2 active hours for documentation and the owner decision packet,
excluding qualified review waits. Estimate fixture remediation separately
if selected. Report before each commit and obtain fresh approval before push.

## #261 inventory correction and publication prevention

The original [tracked-payload inventory](evidence/feature-store-197/tracked-payload-inventory.json)
stays unchanged as history. Its structured-row scan missed forecasts stored as
JSON-encoded strings in #168/#242 archives and did not enumerate the base64
source-map copies in #169. The exact mechanism is demonstrated by the independent
#261 rescan and encoded-string/source-map controls; the reason the original
scanner lacked those decoding paths is an inference from the observed gap.

[The append-only #261 inventory](evidence/feature-store-261/tracked-payload-inventory-f30b93f.json)
covers all 901 paths, 33 compressed files and 360 leaf members at main
`f30b93f23a30316213f07ba346e4a301550d57b0`. It decodes strings repeatedly,
JSON fragments, declared source maps and nested gzip/USTAR. The inventory records
hashes, sizes and current-path introduction commits without copying row values.

The [owner's disposition](https://github.com/ven2dev/dfs-ev-demo/issues/261#issuecomment-6759765086)
removes the three exact #168/#242 archives going forward after verified durable
private ObjectStore retention. Existing history exposure is accepted, with no
history rewrite or force-push. Their original compact receipts remain unchanged;
public checks recompute available metadata/arithmetic, while only private-byte
audits reproduce full response-value and SQL-oracle checks.

Both #169 archives stay at the two exact approved hashes. The #138 notice is
extended only to their exact encoded copy of the existing 22,624-byte ingestion
receipt; the extension binds the original hash and both archive hashes. If that
original is removed or held, its copies go with it. A changed copy or new archive
hash needs a new disposition. #169's auditor and CI check remain unchanged.

The shared decoder now powers an unconditional complete-tree publication scan
in App checks. Its raw outcome is required by the aggregate CI gate, including
documentation-only changes and intentional empty affected work. Unknown or
malformed containers, unapproved findings and republished removal paths fail.
This technical guard is a regression check against recorded dispositions, not
a substitute for #256's qualified rights review or an application release gate.
The approved synthetic/existing-notice exceptions remain exact hash decisions;
a payload's own `synthetic` marker grants no exemption.

See [#261 design and audit boundaries](evidence-payload-publication.md) and
[evidence instructions](evidence/feature-store-261/README.md). No fixture notice,
public-serving approval, lineage or audience is broadened by this correction.
