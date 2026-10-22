# #61 HTTP timeout qualification — local components, steps 1–3

These are components of the disposable experiment, not a deployable
candidate. Step 1 was committed as `3afed44`, step 2 as `0f53155`;
step 3 awaits commit approval.
No HTTP qualification has run. The new module is not connected to a
route. Existing profiling routes/configuration are historical and are not approved
for another deployment. No new credential or hosted role exists.

## Design basis

- Pattern: dedicated least-privilege workload identity with database-scoped
  server timeout defaults installed before first login; finite functional probes
  precede performance testing. The owner-approved local PostgreSQL 18.6 / 512 MiB
  spike passed eight checks on 2026-10-22.
- Alternatives: installing a timeout inside the executing statement failed the
  local spike; switching to a session transport adds connection lifecycle work
  before the narrower HTTP hypothesis has been tested; modifying shared owner
  defaults risks unrelated application and pipeline workloads.
- Targets: HTTP statement cancellation at the configured five-second server
  deadline, lock cancellation at two seconds, rollback and cleanup fencing.
  Permanent performance targets remain 50 ms client p95 / 35 ms headroom at
  20 workers. These functional probes establish no latency acceptance result.
- Requirement reasons: distinguish server statement timeout from client/user
  cancellation to avoid false protection claims; drain concurrent probes before
  reporting failure to avoid teardown racing outstanding work; check rollback to
  prevent uncertain writes being mistaken for safe cancellation; retain identity
  and action allowlists to protect unrelated data.
- Assumptions: separately approved exact Preview database/role/credential and
  deployment. No shared ACL, existing-role or Production changes are permitted.

## Implemented local component

`bench61-timeout.ts` validates the exact hostname, database, role and fixed
synthetic schema before constructing the HTTP client. It inspects defaults on
sequential and three concurrent calls, uses a finite six-second sleep with a
later ten-second client deadline, requires PostgreSQL 57014 with a statement
timeout reason, and checks rollback of a guarded single-command debit.

Seven unit tests pass; web typechecking and targeted ESLint pass. These tests
exercise the probe implementation using mocks; they are not Neon evidence.
The earlier real local PostgreSQL evidence is recorded separately in the
owner's planning folder.

## Step 2 — finite local behavior regression

The server lock-error validator requires SQLSTATE 55P03 and a lock-timeout
reason; NOWAIT errors, statement timeout and client cancellation fail this
check. A unit regression verifies concurrent identity probes drain on failure.

The opt-in root PostgreSQL test exercises the actual probe SQL and role defaults
against PostgreSQL 18.6 on the fixed local fixture, via a transport adapter.
It uses a separately named local login and normalizes only that expected local
login to the HTTP probe's configured identity. It does not emulate or prove
HTTP pooling. Server statement cancellation and implicit-transaction rollback
pass, as does a real two-second lock timeout with unchanged balance.

The same regression refuses mismatched owner/request identities. A bounded
1.5-second single-command debit holds the shared transaction fence while its
500 ms fixture lease expires naturally. Concurrent cleanup refuses without
changing the control row; late admission fails; the already-admitted debit
commits once. Cleanup then succeeds twice. The fixture never runs a performance
workload: the focused invocation selects only this finite regression.

Validation: seven unit tests; one real PostgreSQL regression (13.82 seconds
suite duration), nine older regressions intentionally unselected; ten opt-in
tests skipped without authorization; web typecheck, targeted lint and ten import
boundary checks pass. Role/schema absence and unchanged operator timeout
defaults were independently queried before the fixture was stopped. See
`docs/evidence/206-profile/local-timeout-role-receipt.json`.

## Remaining candidate work before deployment review

1. Add owner-validated setup/least-privilege grants, effective privilege audit,
   dedicated credential handling and retryable teardown. Refuse existing names.
2. Wire finite HTTP lock-timeout and concurrent cleanup/expiry orchestration;
   its local SQL/error regressions are now established. Preserve the previously
   reviewed lease and transaction fence.
3. Wire a qualification-only route/UI, remove performance/old profiling action
   admission, and regenerate the expiring deployment token. Performance/idle
   admission is now closed (step 3 below); qualification itself is not wired.
   The partial module's `performanceEnabled: false` remains descriptive.
4. Verify integration, counts and production compilation; obtain local candidate
   review and fresh push/deployment consent. Do not deploy this partial step.
5. Run actual managed HTTP qualification. Only a complete pass can support a
   subsequent owner decision about a 20-worker performance experiment.

No provider requests, database-package, pipeline, CI, dependency or lockfile
changes are included. The disposable experiment is never merged into main.

## Step 3 — close performance admission and verify the suite

The HTTP authorizer now accepts only setup, catalog and cleanup. The page no
longer offers run or idle-sample actions. Even a valid token in the correct
Preview environment cannot admit run, cold1–3 or the not-yet-wired qualify
action: route tests assert 404 before database-client construction. Historical
profiling functions remain solely for opt-in regressions, not HTTP admission.

Validation on Node 24: 12 focused tests pass; the full suite passes with 951
application tests and 302 Node tests (10 opt-in tests skipped). Web typecheck,
targeted ESLint and whitespace checks pass. The first sandboxed full-suite run
failed existing loopback-server tests with listen EPERM; the rerun with loopback
permission passed. No database fixture, hosted request, new credential or
performance run was used in this step.
