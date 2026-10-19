# Legacy evidence-graph retirement (#177)

## Design basis

- Pattern: expand/contract deprecation. Archive and remove unwired application
  code now; keep immutable schema history until a separately approved contraction.
- Alternatives: quarantine-in-place retains maintenance and test cost and moves
  dead code into #148; deleting historical migrations breaks reproducibility
  while hosted state is unverified. Neither is the approved direction.
- Targets: zero live imports or runnable commands into the retired runtime;
  preserve the three active feature-store unit files and every remaining DB test;
  keep all 11 frozen migrations, schema, catalog and readiness bytes unchanged;
  pass typecheck, lint, unit tests and combined database validation. No runtime
  or query changes are proposed, so no latency or speedup claim is made.
- Requirement reasons: retain the historical role bootstrap so prefix ACL checks
  remain reproducible; relocate active tests so removal does not erase current
  coverage; retain complete schema/readiness history so this change cannot
  misrepresent applied environments. Hosted schema contraction waits for #95.
- Assumptions: the legacy runtime has no feature-store, projection, creator or
  route imports. #185's coverage prerequisite merged through #186 with green CI.
  Only disposable local databases are used; the implementation cap is five hours.

## Archive and schema disposition

The annotated tag `archive/legacy-evidence-graph` identifies the main baseline
immediately before removal:

- Commit: `cf13f2c8d57d23e376041ca79093ba46a9d376c1`
- Tag object: `1b53732fb3780d3c1b0c3fc7d40efea7958c6365`
- Publication: local only, awaiting fresh owner push approval before PR merge.

The [archived commit](https://github.com/ven2dev/dfs-ev-demo/tree/cf13f2c8d57d23e376041ca79093ba46a9d376c1)
already provides a stable source reference. Existing #106/#118/#127 reference
branches stay unchanged. Integrations use merges, without rewriting commits.

All 11 frozen migrations, catalog contracts, generated schema, migration manifest
and readiness policy/manifest stay byte-identical. The creator-track migration
0004 and creator code are retained. Keeping these historical objects is a
deliberate decision, not a claim that they have been applied to Production.

## Inventory and removal boundary

The [exact inventory](evidence/legacy-evidence-177/inventory.json) lists each
removed file, preserved test relocation, package command, historical document,
role-bootstrap move and retained schema/readiness artifact with its hash.

| Boundary | Disposition |
| --- | --- |
| 29 `src/lib/predictive` modules | Archive, then remove |
| Six `scripts/predictive` files and four npm commands | Remove; preserve minimal role setup in test infrastructure |
| 13 legacy unit-test files and four fixture files | Remove |
| Four legacy PostgreSQL suites and their dedicated support | Remove with their obsolete scratch lane and named-case gate |
| Three `featureStore*.test.ts` files | Relocate from `tests/predictive` to `tests/feature-store` |
| All remaining database tests and completeness checks | Retain; reject missing, failed, skipped, duplicate or wrong-file results |
| Feature-store, projection, creator code and proposal SQL | Retain unchanged |
| Historical engineering evidence | Retain with retirement notices; commands/paths refer to the archive |

The DB runner retains its Node migration/catalog checks and single serial Vitest
suite. Historical role setup creates only the same five NOLOGIN roles used by
conditional grants in frozen migrations; it grants no synthetic harness session.
The existing feature-store CI step remains unchanged. Future layout work in #148
can move the active code without carrying the retired runtime.

## Checkpoint

The local removal checkpoint passes. The [compact receipt](evidence/legacy-evidence-177/checkpoint.json)
records code/log hashes, counts and the preservation audit; full logs stay off git.

- Typecheck and lint pass; 900 browser and 243 Node unit tests pass.
- The focused database guards pass 20/20 and CI gates pass 4/4.
- The combined database checkpoint passes: one lifecycle probe, 74 Node database
  checks, 12 catalog contracts and 25 retained PostgreSQL tests.
- All 77 feature-store PostgreSQL tests pass on the standard disposable database
  with its 512 MiB data tmpfs; no spike override is used.
- All 27 inventoried schema/readiness artifacts match the archived baseline,
  including all 11 migrations. The three active tests retain their contents
  except for one adjusted relative fixture import; the live-reference scan is empty.

The 74 Node database cases replace 75 only because the dedicated retired-suite
report test was removed. The retained lease, readiness and creator required-case
contracts remain intact. Validation timings are receipts, not a measured speedup.

Self-review found no confirmed defect. Owner independent review is still pending.
Commit, push and archive-tag publication await their respective owner approvals.
The archive tag is local only. No hosted changes occur.
