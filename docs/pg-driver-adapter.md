# Web PostgreSQL driver adapter (#309)

Status: A1 accepted; A2 implemented and awaiting owner review/commit. `getSql()`
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
pre-provider latency target stays 90 ms: cache 10 / admission 53 / headroom 27. Keep
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

## A2 transport scope and acquisition proposal

The owner-approved [roadmap amendment](https://github.com/ven2dev/dfs-ev-demo/issues/309#issuecomment-7116161641)
keeps **90 ms / p95 <=63 ms** as full-path latency targets qualified during
the real-app PlanetScale Preview cutover rehearsal. They are not evidence of an
existing shared runtime timer. A2 preserves supplied cancellation/deadline
signals and charges checkout to their original allowance; all other acquisition
waits are finite and reported. #309 adds no shared cache/admission deadline
plumbing and makes no full-path runtime timeout enforcement claim. Cutover
measurement includes connection, checkout, SQL and control time. Only if that
measurement shows a need should runtime enforcement be considered as a possible
follow-up.

**Proposal for review before the A2 commit: a 2,000 ms acquisition ceiling.**
This is about 22 times the 90 ms warm latency target and one tenth of the
existing 20 s provider abort. It gives a cold connection or short pool queue
room to complete while containing saturation/connection failure well before
that abort. It does not establish a latency pass or allocate two seconds per
statement to the warm path. The adapter and pg pool both bound acquisition;
a shorter supplied signal wins. The original readiness signal spans checkout
and all statements of both readiness transactions without being restarted.

The proposed pool policy is min=0, idle timeout 5 s, maximum lifetime 60 s and
client query timeout 15 s. These are containment/lifecycle hypotheses for review,
not observed hosted limits. A client query timer does not prove backend
termination. The factory requires an explicit maximum; the fixed local bound
of two clients per owner is not a selected deployed pool size. There was no
m=2/5/10 experiment. Final capacity selection remains at cutover rehearsal.

## A2 implementation and safety

`pgPool.server.ts` owns lazy creation, validation before creation/cached reuse,
one lifecycle attachment per pool and sanitized failures. Changed bindings
refuse cached reuse rather than silently switching targets. Refused configuration
creates no pool and attempts no connection. Idle failures are handled with a
fixed reason-only warning or sanitized callback; a throwing callback cannot
become an unhandled pool error. Attachment failure closes the unused pool.

The URL is parsed into explicit pg fields rather than passed as
`connectionString`. TLS uses certificate/hostname verification; absent sslmode,
`require` and `verify-full` select the same verified TLS policy. Other URL
options, duplicate modes and weaker modes refuse before creation. This prevents
URL SSL options from replacing explicit verification or injecting session/target
overrides. A whitespace startup options string suppresses pg's ambient
PGOPTIONS fallback without issuing setup SQL. No new environment input or
runtime TEST_DATABASE_URL fallback is introduced.

Ordinary queries now explicitly acquire and release one client. A late checkout
after cancellation/expiry is released unused, with no domain SQL. During an
aborted transaction the active client is discarded once and subsequent SQL is
not sent. No separate cancellation connection or automatic replay is added.
Only recoverable server SQL errors permit rollback/reuse; transport/client
timeouts, connection failures, failed BEGIN/ROLLBACK and ambiguous COMMIT discard
the uncertain client. Cancellation during rollback also bounds cleanup, while
the original statement failure is retained. The narrow internal `createPgSql`
factory retains raw errors for controlled proofs; its configuration owner
normalizes every query/transaction error before returning it to consumers.

## A2 proof and work counts

The compact A2 receipt records source identities and check results. There are
**21 new risk-backed tests in A2**: 13 synthetic pool/lifecycle/cancellation
tests, seven real PostgreSQL cases and one report-contract test. Two A1 failure
fixtures now carry a server SQLSTATE so they continue to exercise rollback;
an unclassified transport failure intentionally takes the discard path instead.
No existing application consumer behavior is changed in this checkpoint.

The guarded local core suite executes the seven real cases in
`tests/db/pgDriver309.test.ts`: actual decoding/serialization and unnamed wire
messages; two creator transactions observed blocked behind a held advisory lock,
one returned ID and rollback without an orphan creator; both actual readiness
batches and DDL between them; a stable read-only Repeatable Read snapshot;
server timeout enforcement/reuse; cancellation/backend containment; and 20
composed leaders through two independent bounded pools with generation overlap.
The mandatory report refuses missing, skipped, failed or relocated proof cases.

| Operation | Observed work |
| --- | --- |
| Warm ordinary query | 1 checkout/release, 1 domain statement, 0 setup/control SQL, 0 new connections. |
| Creator success | 1 checkout/release, 4 domain statements + BEGIN/COMMIT, on 1 client. |
| Readiness absent ledger | 1 transaction: 2 domain statements + BEGIN/COMMIT; no history query. |
| Readiness with ledger | 2 transactions: 2 and 3 domain statements + 4 controls total; original shared signal and read-only Repeatable Read. |
| Each of 20 composed leaders | 4 cache + 1 admission statement before the synthetic provider; 6 cache + 1 admission total. No extra timeout/setup SQL. |
| Two owners, fixed max=2 | 140 domain checkouts/releases for 20 leaders; at most 2 clients per owner, no discard/leak/replay; zero named Parse/Bind/portal messages. |
| Generation overlap | A third max=2 owner overlaps both original pools: 6 held clients in total, then all 6 released. This is a count proof, not hosted capacity approval. |

Connection-establishment, checkout (including connection/queue) and SQL elapsed
times are recorded separately as descriptive local observations. Checkout
includes cold connection time, so they are not summed twice. No wall-clock
assertion certifies the hosted latency target. Existing cache/admission/follower,
renewal and plan/buffer tests still run; actual getSql integration and final
consumer budget parity belong to B1. Local leader probes use the real 250 ms
poll/45 s lease settings, without fast test replacements.

The disposable PostgreSQL timeout hypotheses are statement=5 s, lock=1 s and
idle-in-transaction=5 s, set as scratch-database defaults. Tests wait for actual
server SQLSTATE refusals, including repeated statement/lock timeouts on a reused
backend, an idle-transaction disconnect and a newly opened replacement. They
also verify that transaction-local settings return to the defaults after commit.
Readiness retains its existing 2 s statement / 1 s lock local controls. Those
controls are existing domain statements; A2 adds no per-borrow SET/SHOW query.
The cancellation proof independently uses a 1 s scratch backend statement limit
and observes the abandoned backend disappear. Socket closure alone is not
described as immediate backend cancellation.

**Hosted gates remain open:** the intended serving role/pooler defaults must
contain every new/reassigned backend, independently of client startup options;
the Preview rehearsal verifies those limits, Fluid suspension/cleanup, TLS and
the owner/fan-out/overlap/capacity observations listed above. Local direct
PostgreSQL does not certify PlanetScale transaction pooling. `getSql()` still
uses Neon, and the driver PR remains unmerged until the approved cutover gate.

The full Node 24.18.1 suite includes the actual resolved **Zod 4.6.7** introduced
in A1 (previously 4.5.4); A2 changes no dependency/lockfile entry. Validation uses
credential-free processes; temporary Vitest overlays only disable dotenv
loading. The normal production build uses synthetic Preview fixture mode.
Supplemental Node/browser/Edge probes use a copied value-free source tree with
Node positive controls and negative direct-import builds; their result and
bundler are recorded in the receipt. No private dotenv file is copied/read.

## A2 validation

The [compact A2 receipt](evidence/pg-driver-309/checkpoint-a2.json) pins the
implementation, tests and dependencies. Main `68dd11e` was merged as `48d0bf9`,
then the locked dependencies were installed and the following checks rerun on
the A2 working tree. In particular, the app resolves its newly merged
eventsource-parser 4.1.3 rather than the unrelated root development copy.

| Check | Result |
| --- | --- |
| Full browser / Node suites | 984 / 1,078 passed; one existing opt-in live R2 test skipped. |
| Isolated adapter tests, included in the Node suite | 50 passed: 37 A1 and 13 A2. |
| CI gate | 63 passed. |
| Guarded core / feature-store PostgreSQL | 96 / 301 passed; all seven mandatory adapter proof cases verified. |
| DB tooling Node checks | 79 passed, including all 75 mandatory cases. |
| Root and web typechecks | Passed. |
| Source ESLint / import boundaries | Passed with ignored scratch excluded / 12 passed. |
| Firebase Admin Node runtime / production build | Passed / passed with default Turbopack in synthetic Preview fixture mode. |
| Supplemental build isolation | Node positive control; no markers in 94 browser/static/Edge files, including 13 Edge files/maps; direct client and Edge imports refused. Supplemental builds use webpack. |
| Publication guard | Committed `48d0bf9`: 1,041 paths, eight approved findings, zero unapproved. It scans committed HEAD, so A2 needs a rerun after its approved commit. |

The original synthetic scheduling screen was repeated against the actual A2
adapter and installed pg pool: three alternating rounds, 1,000 samples per
shape/arm/round after 200 warmups. Worst adapter p95 was **0.005042 ms**, below
the predeclared **0.7 ms** passing threshold (1 ms envelope with at least 30%
headroom). Each timed arm performed 6,000 checkout/releases, 15,000 domain
statements and 6,000 controls, with zero new connections or network attempts.
This screen is neither a real database timing nor the hosted 90 ms qualification.

The cleared lane-3 standard fixture used synthetic records only. Teardown
completed and both its container and network were independently confirmed absent.
No other lane was modified. The acquisition ceiling remains a proposal for
owner review before commit; no consumer has moved onto the adapter.

## References

Reviewed 2026-11-23: [pg types](https://node-postgres.com/features/types),
[pg query-local parsers and parameters](https://node-postgres.com/features/queries),
and [single-client transactions](https://node-postgres.com/features/transactions).
