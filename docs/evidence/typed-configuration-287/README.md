# Configuration ownership qualification (#287)

[Design basis](../../typed-configuration-enforcement.md) ·
[approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/287#issuecomment-6955456041) ·
[qualification receipt](qualification.json)

The receipt qualifies checker source `75b29a3` on main `c15e694`. The final
documentation/evidence commit adds no runtime or enforcement behavior. It
records exact executable-definition alignment, preserved #98 checks, the
current feature-branch sweep and isolated compiler probes. Raw logs, disposable
snapshots and their manifests remain local; committed data contains source/file
identities, counts and outcomes, with no deployed values or credential-derived
fingerprints.

Run `npm run test:ci-gate` on Node 24 for actual core-ESLint negatives, directive
checks, catalog policy and real-module alignment. The import child uses the
established TS loader with `react-server` resolution, dotenv disabled and a
synthetic-only environment. Its traps/spies record zero input reads, parser
calls, private-dotenv reads, SDK calls, SQL calls and network calls. All 20
server and seven client definitions match exact names, reader and resolved
classification. Capabilities and parsing contexts stay code-owned.

The four added alignment test groups reject name omissions/unread rows, reader
changes/duplicate ownership, and reclassification through profiles or overrides;
they also refuse evaluating code-owned parsers/metadata during alignment.
Retired generic-code discovery assertions are replaced by these checks and
application ownership lint, rather than preserved as a test-count target.
Template/workflow coverage, blank secrets, source safety, ledger policy and DB
refusal tests remain. Non-app inputs still need explicit catalog/review updates.

The sweep found zero open PRs and active local #222 source. Its receipt records
original/main/merge/checker identities, working-file hashes and every checker
overlay path. Main was already an ancestor; no new merge commit was necessary.
The first snapshot passed 49 gate tests. After ALT's source and independent
gate additions, the refreshed snapshot passes 60 with no environment violations.
Keep the #222 provider-boundary test and both #287 gate additions when resolving
the shared `test:ci-gate` line. The owner receives that concrete integration
fix in the review handoff. No owner worktree, branch or remote was modified.
Results are tied to the captured source; refresh affected checks if it changes.

The owner excluded both #220 harnesses as **archived spike evidence,
never-merge, intentionally not conformed**. Their exact heads are in the
receipt. `hosted-harness` containment in `planetscale-harness` was checked.
Both remain untouched. Preserving the local-only evidence graph with a tag,
removing worktrees or publishing any such tag is outside this change.
Already-merged refs and other retained historical refs are listed separately;
an open issue alone does not claim active work on an old branch.

The isolated builds copy and verify all 978 tracked source files, then add
temporary server/client pages and an Edge route. The server page reads
`serverConfig.odds().source`; the client page reads
`publicConfig.firebase().projectId`; the Edge route returns a synthetic result.
An additional client page imports `config.server` for the expected refusal.
The temporary routes' hashes and log hashes are recorded. Actual configuration
modules, instrumentation and compiler settings stay byte-identical.

Use an explicit synthetic-only environment, isolated HOME and no copied dotenv
files. The fixture build supplies no live secrets; the second build uses six
synthetic server markers and public Firebase markers. Absent/invalid database
inputs avoid live clients. Installed Next's test-only font-response hook has
exact Geist/Geist Mono URL keys mapped to synthetic CSS without font transfers;
font rendering is outside this proof. Initial incomplete sweep setup and an
initial font-map failure remain recorded, with neither counted as qualification.

The marker build scans 55 browser/static files, checks a public positive control,
and finds zero server markers. All 11 files referenced by the Edge function and
255 source entries across six maps exclude the Node-only startup/configuration
modules. Actual Node chunks retain the startup message and cache SQL as positive
controls. Source-map `sourcesContent` can include the original guarded
instrumentation; this does not mean its Node branch is executable on Edge.
The client/server import probe fails compilation as intended.

These results do not verify deployed IAM, actual credential copies, live target
identity or arbitrary JavaScript data flow. #101 retains deployed verification.
No lane, hosted write, Production credential or provider operation is involved.
