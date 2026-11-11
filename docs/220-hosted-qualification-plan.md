# #220 PlanetScale qualification

This harness branch is for a protected Preview and must never merge. Its proxy
adds an invocation to ordinary API requests, including SSE, and its Vercel
configuration omits scheduled jobs. The existing application's database client
stays on its normal entry point. The Neon parity proposal and #86 remain
separate. This experiment does not authorize a Production cutover.

## Design basis

- **Pattern.** Qualify a disposable PostgreSQL instance with synthetic inputs,
  a restricted runner, and measured traffic from the existing Vercel runtime.
  Use one immutable `iad1` Git Preview and Northern Virginia PS-5 single node.
- **Alternatives.** The Neon parity plan would leave the candidate unevaluated.
  Workers and Hyperdrive would change the runtime and transport together.
  A direct database connection would omit the managed pool whose behavior
  needs qualification.
- **Targets.** Use the 240-key fixture and 18,483-ticket matrix. Require warm
  p95 at most 140 ms in each 20-leader round and at most 200 ms overall per
  mode. Max and p99 are informational. The historical #61 50/35 ms results
  are separate. The synthetic stale path and fresh TCP diagnostic are
  separate from warm qualification.
- **Requirement reasons.** Each load-generator request executes one timed
  invocation. The route bypasses the harness proxy so the invocation budget
  counts the route alone for benchmark traffic. The bearer, exact deployment
  host and verified binding fence the route. Fixed SQL budgets detect added
  work. TLS certificate verification prevents endpoint impersonation.
  Server timeouts bound database work after an application deadline or
  disconnect. No automatic retry follows an ambiguous write.
- **Assumptions.** PostgreSQL 18, PlanetScale PgBouncer in transaction mode,
  Vercel Node 24, verified TLS and a separate owner-approved disposable
  database. A fresh client measures connection to the running pooler.
  Database activation after suspension is outside the candidate measurement.

## Package 1 · local harness

The route uses `pg` 8.23.1 and a 20-client maximum **per function instance**.
Acquisition is bounded at 1.5 s, idle clients expire after 5 s, and Vercel
attaches its pool lifecycle hook. Fresh-client samples use a separate
single-client pool closed after the query. PlanetScale's aggregate connection
limits and Vercel lifecycle behavior require hosted preflight. The ordinary
app client and the admission proposal are unchanged.

Binding pins the exact branch and SHA, Vercel project and region, candidate
cluster and branch IDs, and exact host, port, database and runner role.
The pooled connection on port 6432 uses `role.branch_id` as its login.
SQL grants and the hosted run fence use the bare role returned by
`current_user`. Use a canonical
`?sslmode=verify-full` query string. The adapter constructs its own strict
TLS options. Owner-verifiable provider metadata binds the cluster and branch
IDs to the managed endpoint. Those IDs are control-plane metadata.

The synthetic free observation uses the same fixed quota total and period as
the stale fixture. It never makes an external provider call. Its timings
measure the quota-recovery mechanics only. Stale followers return immediately.

| Sample | SQL before the boundary | After the boundary |
| --- | ---: | --- |
| Warm baseline | 1 | 1 separate `SELECT 1` |
| Warm admission | 1 | 1 leader release |
| Warm full path | 2 | 1 leader release |
| Fresh client diagnostic | 1 | 0 |
| Stale path | 2–5 | 1 leader release when admitted |
| Same-subject control | 1 | 1 leader release |

The runner reports in-function time, accumulated checkout time, and per-query
round trip. Client HTTP timing is context. The 20-ticket same-subject control
uses distinct keys and shared subject rows and is reported separately from the
18,483 scheduled tickets. A held-key follower consumes no credit or subject
charge in the local proof.

Local commands, run from the repository root using Node 24:

```sh
node --test tests/220-hosted-harness.check.mjs
bash scripts/spikes/220-hosted/local-pool.sh
npm run typecheck
npm run lint
npm run build
```

The default Turbopack production build passed during independent review.
The local Webpack production build also passed.

The pool proof creates a private PostgreSQL 18 fixture with 512 MiB tmpfs and
a pinned TLS PgBouncer container, with independent loopback ports. This
allows disposable trust authentication inside the private fixture and verifies
frontend certificate handling without changing any shared database lane.
The test checks real backend reuse, timeouts, recovery, role permissions,
contention and quota behavior, then verifies fixture cleanup.

## Package 2 · owner approval gates

Estimate **3–4.5 active hours**. Obtain separate approvals for provisioning,
the Preview push and the hosted run. Owner handles account, payment and
credentials. Enter the DSN directly into the harness branch's Preview Secret.
The owner supplies the bearer and bypass to the runner in memory from the
password manager. Keep credential values out of chat, logs and files.
Retain only sanitized metadata in receipts. Do not copy Production
rows or reuse Production credentials.

1. Provision the exact disposable Northern Virginia PS-5. Confirm SKU,
   billing basis, actual pool and TLS settings, the managed runner role,
   grants and server timeout behavior. Prove cancellation and lock refusal
   through that pool before timing. Functions are SECURITY INVOKER. Ticket
   transitions are enforced in function code. The runner technically holds
   ticket UPDATE and budget DML, so keep the DSN server-only and the cluster
   disposable.
   Owner provisioning checks observed verified TLS, the scoped grants, and
   statement (`57014`), lock (`55P03`) and idle transaction (`25P03`)
   enforcement through the managed pool. A new connection recovered after the
   idle termination. PostgreSQL applies role defaults when a backend starts.
   Pooled backends opened before the role change keep their previous defaults,
   including disabled timeouts. The older backend's zero values reflect those
   pre-change defaults. A fresh pooled backend reported `5s`, `2s`, and `5s`.
2. Push one approved commit for Git Preview. Verify Ready, deployment ID and
   URL, actual function region metadata, approved SHA, Protection Bypass
   and exact-branch Preview Secret scope. Confirm ordinary API and cron
   requests are blocked and the benchmark bypasses the proxy.
3. Record Hobby usage before preflight and refresh before timed blocks.
   Cap the entire experiment at 20,000 invocations, including 18,483 matrix
   samples and up to 1,517 controls and preflight requests. Start at no more
   than 880,000 team invocations. Stop before projected usage exceeds
   900,000, leaving 100,000 in reserve. Check CPU and memory reserves as well.
   Measure inside each function. Drain all requests before switching groups.

   Before timing, retire all pre-change pooled backends by resetting the pool
   or waiting beyond its verified server connection lifetime. Open at least a
   full pool's worth of concurrent connections through the pooled endpoint.
   Keep transactions open during the inspection so each connection checks a
   distinct PostgreSQL backend, and record `pg_backend_pid()` to establish
   coverage. Confirm every backend reports `statement_timeout=5s`,
   `lock_timeout=2s`, and `idle_in_transaction_session_timeout=5s`.
   Record the configured pool size, the number of distinct backends checked,
   and the distinct timeout values in the private receipt. Stop the run if
   any backend reports `0`, any expected value differs, or full-pool coverage
   cannot be established. This gate prevents a pre-change backend from
   admitting database work with disabled timeouts.

4. Outside the timed matrix, create a restore point with a committed sentinel.
   Restore to a separate approved target and verify the sentinel and expected
   counts or hashes. Record observed recovery point, restore time, and billing.
5. Remove and verify absence of the exact restore target, trial cluster and
   role, branch-scoped secrets, Preview and owner-managed runner material.

Package 1 review precedes its first commit. Hosted configuration and billing
claims remain pending actual Package 2 verification.
