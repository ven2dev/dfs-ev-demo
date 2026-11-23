# Web PostgreSQL driver adapter (#309)

Status: checkpoint A1, isolated contract and decoding implementation. `getSql()`
still uses Neon. Consumer migration waits for checkpoint A2's pool safety and
local PostgreSQL proofs. The [approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/309#issuecomment-7112036211)
defines the commit gates and review requirements.

## Design basis

**Pattern:** a narrow compatibility adapter behind the existing `getSql()`
boundary, with deferred statement descriptions and one checked-out client per
transaction. A1 accepts an injected pg pool; it does not create a runtime pool
or change consumers. A2 owns bounded lazy pool creation, configuration validation
on creation/reuse, verified TLS, lifecycle attachment, acquisition deadlines and
cancellation safety. B1 switches the single entry point after A is accepted.

**Alternatives:** connecting per query adds connection churn and latency;
returning `pg.Result` spreads transport changes through repositories; using
`pool.query()` for individual transaction statements loses transaction affinity;
an ORM or general provider framework expands the abstraction for one target.

**Targets:** preserve all 34 acquisitions across 17 non-test modules and all
three transaction sites at main `0b15f80`. A warm ordinary query has one domain
statement and no setup SQL. Creator success uses four ordered domain statements
plus BEGIN/COMMIT on one client. The two readiness batches have two and three
domain statements, respectively, preserving read-only Repeatable Read and the
original deadline signal. Report controls separately. The complete warm
pre-provider budget stays 90 ms: cache 10 / admission 53 / headroom 27. Keep
the existing cache/admission/follower/renewal/buffer budgets; hosted p95 <=63 ms
is proved during the real-app PlanetScale Preview cutover rehearsal, not here.

**Requirement reasons:**

- Keep row arrays and public serialization unchanged to avoid domain regressions.
- Scope parsers to adapter queries without changing global pg parsers, protecting
  the pipeline's existing driver consumers.
- Build statements before checkout and execute the batch on one client, keeping
  creator locks/rollback and readiness snapshots atomic.
- Accept text and bound parameters only; no named statements or SQL PREPARE,
  avoiding a dependency on backend affinity in transaction pooling.
- Release healthy clients and discard uncertain transaction state; do not replay
  ambiguous writes, preventing leaks, cross-borrower state and duplicate writes.
- Keep the module server-only to prevent Node transport entering client bundles.
- Do not move consumers before A2 passes, since A1 alone does not establish
  cancellation deadlines, backend timeouts, TLS or serverless lifecycle safety.

**Assumptions:** Node 24.18.1, Node server runtime, selected target PlanetScale
PS-5 single-node in AWS us-east-1 with iad1 functions only. A1 tests use synthetic
rows/protocol events and an injected transport; they make no database connection.
Local disposable PostgreSQL proofs follow the shared-lane coordination rule in
[database-testing.md](database-testing.md) during A2. Hosted access is separate.

## Contract and compatibility

`pgSql.ts` supplies only `.query(text, parameters)` and the synchronous
`.transaction(builder, options)` shape currently used by repositories. The
builder's `query()` returns an opaque description rather than an executing
promise. Only descriptions created for that batch are accepted. Query objects,
tagged templates, arbitrary transaction callbacks and a provider fallback are
outside this narrow API.

Current default text decoding is compared with the installed Neon HTTP driver
using synthetic HTTP responses. The pg side uses its installed row decoder with
query-local `TypeOverrides`; no global `setTypeParser()` call is made. A1 checks
the decoded values and serialized output, including numeric/bigint, nulls,
JSON/JSONB, arrays, date/timestamp/timezone and sub-millisecond inputs. Existing
SQL text/JSON projections retain their full textual precision; typed JavaScript
Date values retain the existing driver's millisecond precision. Changing those
semantics would require a separately reported behavior decision.

The SQL PREPARE guard conservatively rejects that whole word anywhere in an
internal statement, including comments/literals. This small API is for the
inventoried repository SQL, not arbitrary user SQL; no SQL parser is introduced.
If a future legitimate statement needs that word, revisit this constraint rather
than silently bypass it. Query configs are not accepted, so callers cannot supply
a prepared-statement name. Real protocol proof is an A2 gate.

## Pool size and cutover ordering

The plan budgets all independent pool owners and overlapping deployments:
`I * G * m + Hclient <= Bclient`, with a separate backend budget including
pooler role/database pools and job/admin reserve. A2 proves bounded-pool,
release, exhaustion and queue-expiry safety at a fixed test bound; it does not
run an m=2/5/10 sizing experiment. Final pool size is selected at cutover
rehearsal from observed Vercel/PlanetScale limits and this formula.

The #309 PR stays unmerged until its real-app PlanetScale Preview passes and
merges as part of cutover, so Production never runs pg against Neon. #95 owns
migration-ledger adoption, #101 deployed identity/delivery, and #285 cache
activation remains separately gated. Keep merging main into the branch; rerun
the full suite and CI gate after every merge. Every commit and push requires
its own approval.

## A1 validation

The [compact A1 receipt](evidence/pg-driver-309/checkpoint-a1.json) pins the
adapter, tests and dependency files. The focused set has 37 new tests tied to
contract risks: row cardinality/IDs, bound parameters, installed-driver decoding
and serialization parity, three timezones, deferred transaction membership and
order, readiness options, release/discard, failure without replay and invalid
inputs before checkout. No existing consumer test behavior changed.

The CI gate passed 63 checks, both typechecks passed, and source ESLint plus
12 import-boundary checks passed. Local lint excludes the ignored scratch
folder `codex-briefs/`; plain `npm run lint` includes historical scratch files.
Full suites, build, prompt cancellation/lifecycle checks and real disposable
PostgreSQL proofs remain A2/B gates. No hosted latency or capacity is claimed.

Adding the approved Vercel lifecycle dependency introduces 15 lockfile entries
through its OIDC/CLI-config dependency tree. Its Zod requirement raises the
existing resolved Zod from 4.5.4 to 4.6.7 and makes the relevant transitive
packages runtime dependencies. Other existing resolved versions are unchanged.
The S3 workspace declaration remains unchanged for the separate B2 commit.

## References

Reviewed 2026-11-23: [pg types](https://node-postgres.com/features/types),
[pg query-local parsers and parameters](https://node-postgres.com/features/queries),
and [single-client transactions](https://node-postgres.com/features/transactions).
