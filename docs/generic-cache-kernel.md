# Generic cache kernel (#209)

## Design basis

**Pattern.** The cache uses a generic, lease-backed singleflight kernel beside
the generic PostgreSQL cache store. `@dfs-ev/db/runtime` exports
`getOrRefresh<T>`, its dependency type and its options. The kernel treats `T`
as opaque. Web retains provider requests, `LivePropInputs`, cancellation, odds
history, TTL, clocks and identifier composition. This keeps the dependency
direction one way: web uses DB runtime, while DB runtime imports neither web,
pipeline, domain, provider clients nor framework code.

**Alternatives.** A dedicated cache workspace would make kernel edits select a
smaller CI graph, but would add a package, export surface and build boundary
without improving the current safety target. The broader server-runtime proposal
would also move provider contracts and application composition that have no
real-database coverage. Keeping the kernel in web would leave every UI edit
responsible for the ordinary PostgreSQL suite. The selected design keeps the
generic kernel in the existing DB runtime and accepts conservative full-graph
selection for a DB-kernel change.

**Targets.** A fresh cache hit keeps one cache query and no provider/history
calls. An uncontended refresh keeps three cache queries, one odds request, one
weather request and the existing eligible history callback. UI-only and retained
web-composition edits select neither PostgreSQL suite. A DB kernel or its
25-contender scenario selects the ordinary suite; DB's conservative fallback
also selects feature-store work. All selected Turbo tasks remain uncached.

**Requirement reasons.** Opaque payloads prevent provider policy from leaking
into infrastructure. Public runtime imports and boundary probes prevent reverse
dependencies and private cross-package paths. Exact test names and inventories
prevent a mechanical move from dropping coverage. The explicit PostgreSQL
exclusion keeps generic units out of a database lane. Preserved migration,
catalog, readiness and SQL bytes prevent an ownership change from rewriting
database behavior.

**Assumptions and limits.** Node 24, npm workspaces, the existing 512 MiB
disposable PostgreSQL fixture and Vercel's existing outside-root configuration
remain in use. The web composition has fake wiring coverage but no real DB test:
the DB scenario covers SQL/lease concurrency, while a protected Preview's
read-only readiness query remains the pre-merge driver-binding check.

## Ownership and verification

The moved kernel, store-adapter unit and 25-contender scenario live with DB
runtime/tooling. The original eight repository tests remain in web. A web wiring
sentinel verifies lazy query binding, TTL, IDs, clock and fetch callbacks at the
public kernel boundary. `packages/db/tooling/tests/unit/**` runs once in the
Node unit lane and is explicitly excluded from PostgreSQL discovery.

DB runtime declares `test:db:local`; web no longer does. The Turbo matrix uses
real disposable Git ranges to show that the same UI edit changed from selecting
the ordinary suite under the old ownership to selecting only web tests under the
new ownership. Unknown and global inputs still run the complete graph or refuse
visibly. The small CI translator interprets only Turbo task IDs. It does not
classify paths or construct a second dependency graph.

Move the kernel out of DB runtime before adding Next/server-only, provider SDK or
domain dependencies, or provider/credit-spend policy such as a #61 debit. A
separate package is also an optional future optimization if conservative
full-graph DB-kernel validation becomes too costly.

The compact local checkpoint is
[step-4-checkpoint.json](evidence/turborepo-209/step-4-checkpoint.json).
Hosted CI and a protected Preview verification remain separate pre-merge gates.
