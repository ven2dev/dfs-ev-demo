# Participation evidence notice

The participation-related data excerpts listed below are offered under
[Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/).
The excerpts document a 2025 player/game row with a participation gap and a
2024 play excluded because its participation list contained a duplicate. The
source rows were selected, compared across feeds and summarized for diagnosis.

| Source | Credit and declared source license |
| --- | --- |
| Participation, 2021–2022 | NFL NextGenStats via nflverse. CC BY-SA 4.0. [Pinned participation declaration](https://github.com/nflverse/nflreadr/blob/23f915a5be30415aeaa0c5c80cd23b2c69cda122/R/load_participation.R#L4-L8) |
| Participation, 2023–2025 | FTN Data via nflverse. CC BY-SA 4.0. [Pinned participation declaration](https://github.com/nflverse/nflreadr/blob/23f915a5be30415aeaa0c5c80cd23b2c69cda122/R/load_participation.R#L4-L8) |
| Weekly player stats used in the 2025 diagnostic | nflverse contributors. CC BY 4.0. [Pinned player stats release license](https://github.com/nflverse/nflverse-data/blob/0170a83ddb947bd82ddf66e78b4d9f0889f6c195/LICENSE.md) |

Affected excerpts appear in these files:

- [Source inventory](source-inventory.json)
- [Step 3 checkpoint](step-3-checkpoint.json)
- [Participation anomaly](step-3-participation-anomaly.json)
- [Initial real-ingestion receipt](step-3-real-ingestion-initial.json)
- [Real-ingestion receipt](step-3-real-ingestion.json)
- [Source walkthrough](../../feature-store-spike-sources.md)
- [Spike report](../../feature-store-spike.md)

The [#197 inventory](../feature-store-197/tracked-payload-inventory.json)
identifies the baseline versions. The [#241 combined fixture](../../../services/pipeline/tests/feature-store/fixtures/NOTICE.participation.md)
has a separate notice.

## Exact copies in #169 evidence

The owner's [2026-11-09 decision](https://github.com/ven2dev/dfs-ev-demo/issues/261#issuecomment-6759765086)
extends this notice only to the exact embedded copies of
`docs/evidence/feature-store-138/step-3-real-ingestion.json` in the following two
archives. The decoded source is 22,624 bytes, SHA-256
`a08d54d2c8a53eb550a900a81ad32ce70d7fc9e44683fea7dcfd2f310e743db9`.
Each copy is encoded in the run record's `records["sources.json"]` map.

| Archive | Complete archive SHA-256 |
| --- | --- |
| [#169 original qualification](../feature-store-169/records-20261109T050208Z.tar.gz) | `99fa7a58f3d73e41b3c7f0d08c0350ece1442e16e567c35d951adca8d4eba230` |
| [#169 requalification](../feature-store-169/records-20261109T061738Z.tar.gz) | `0a119dfed3b46860631ef912aa2db2e88c931ca76601edf87254dc3d9876fcd0` |

This extension changes no other scope, output, audience or terms of this notice.
A changed copy or a different archive hash is a new finding. If the original
#138 file is ever removed or held, these copies go with it.
