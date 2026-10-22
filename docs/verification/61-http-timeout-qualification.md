# #61 HTTP timeout qualification — local candidate, step 1

This is an uncommitted component of the disposable experiment, not a deployable
candidate. No HTTP qualification has run. The new module is not connected to a
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

Five unit tests pass; web typechecking and targeted ESLint pass. These tests
exercise the probe implementation using mocks; they are not Neon evidence.
The earlier real local PostgreSQL evidence is recorded separately in the
owner's planning folder.

## Remaining candidate work before deployment review

1. Add owner-validated setup/least-privilege grants, effective privilege audit,
   dedicated credential handling and retryable teardown. Refuse existing names.
2. Add finite HTTP lock-timeout and concurrent cleanup/expiry probes and their
   regressions. Preserve the previously reviewed lease and transaction fence.
3. Wire a qualification-only route/UI, remove performance/old profiling action
   admission, and regenerate the expiring deployment token. The partial module's
   `performanceEnabled: false` is descriptive; it is not the route gate.
4. Verify integration, counts and production compilation; obtain local candidate
   review and fresh push/deployment consent. Do not deploy this partial step.
5. Run actual managed HTTP qualification. Only a complete pass can support a
   subsequent owner decision about a 20-worker performance experiment.

No provider requests, database-package, pipeline, CI, dependency or lockfile
changes are included. The disposable experiment is never merged into main.
