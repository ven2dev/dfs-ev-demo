# Participation data notice

This notice covers [the normalized #241 CI fixture](job-visibility-work-v1.json.gz).
The fixture is offered under [Creative Commons Attribution-ShareAlike 4.0
International](https://creativecommons.org/licenses/by-sa/4.0/). Its
[manifest](job-visibility-work-v1.manifest.json) identifies the exact upstream
files and their hashes.

| Feed | Credit and declared source license |
| --- | --- |
| Participation, 2021–2022 | NFL NextGenStats via nflverse. CC BY-SA 4.0. [Pinned participation declaration](https://github.com/nflverse/nflreadr/blob/23f915a5be30415aeaa0c5c80cd23b2c69cda122/R/load_participation.R#L4-L8) |
| Participation, 2023–2025 | FTN Data via nflverse. CC BY-SA 4.0. [Pinned participation declaration](https://github.com/nflverse/nflreadr/blob/23f915a5be30415aeaa0c5c80cd23b2c69cda122/R/load_participation.R#L4-L8) |
| Schedules | Lee Sharpe and nflverse. CC BY 4.0 for the nflverse-data release copy. [Pinned schedules release license](https://github.com/nflverse/nflverse-data/blob/ab1331c85fd222ce953fe61363b099c0629de0a1/LICENSE.md) |
| Weekly rosters | nflverse contributors. CC BY 4.0. [Pinned weekly rosters release license](https://github.com/nflverse/nflverse-data/blob/1709b7a448c464dade95669c2c85082a673da180/LICENSE.md) |
| Weekly player stats | nflverse contributors. CC BY 4.0. [Pinned player stats release license](https://github.com/nflverse/nflverse-data/blob/0170a83ddb947bd82ddf66e78b4d9f0889f6c195/LICENSE.md) |

The fixture aggregates play-by-play participation to offensive-play counts per
player and game, filters and normalizes records, converts schedule times from
Eastern time to UTC, and joins schedules, rosters and player stats to construct
feature and outcome rows. The upstream inputs retain the terms listed above.

This notice covers the identified data fixture. Application source, future
product outputs and the [#138 evidence excerpts](../../../../../docs/evidence/feature-store-138/NOTICE.participation.md)
have separate scopes.
