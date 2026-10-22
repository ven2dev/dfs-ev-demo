# #61 finite HTTP timeout qualification

Status: complete local candidate, awaiting commit approval and independent review.
No hosted role, credential file, push or deployment exists for this candidate.
It is a throwaway branch: no PR or merge. Permanent implementation and performance
execution remain blocked. Review this step against 42cf489; earlier approved
commits are 3afed44 (probes), 0f53155 (role regression), and 42cf489 (admission gate).

## Design basis

- Pattern: dedicated least-privilege login with database-scoped timeout defaults
  installed before first authentication, followed by single-statement implicit
  transactions. Teardown retains the approved lease and transaction advisory fence.
- Alternatives: setting statement_timeout inside execution failed the earlier local
  spike; a session transport adds lifecycle work before testing the narrower HTTP
  hypothesis; changing existing owner/app/pipeline defaults risks unrelated work.
- Targets: five-second server statement cancellation, two-second lock cancellation,
  rollback and cleanup fencing. Six-second cancellation sleeps and four-second
  lock/fence sleeps are finite; client deadlines are later, at ten seconds.
  The future 20-worker targets remain 50 ms p95 / 35 ms headroom. No performance
  distributions or acceptance measurements are collected in this test.
- Requirement reasons: server error reasons prevent mistaking client cancellation
  for protection; draining prevents teardown races; ownership checks prevent
  deleting another run; no automatic write retries prevents duplicate debits;
  synthetic data and isolated privileges protect app/pipeline data.
- Assumptions: separately approved exact Preview target, private credential channel,
  operator role-creation/activity-observation privileges and capacity for three
  concurrent probes. Missing capabilities stop the test, without widening access.

## Fixed target and setup

Host: ep-broad-mouse-b773hf6f-pooler.c-13.us-east-1.aws.neon.tech; region iad1.
Schema: bench61_http_role_20261022. Login: bench61_http_timeout_20261022,
connection limit eight (functional testing only, not authorization for 20 workers).

Setup is one atomic transaction. It takes the exclusive advisory fence, refuses
either existing name, creates/configures the role before first login, and creates
the schema, control row, budget and invoker guard. The operator owns all objects.
The new role has no superuser, database/role creation, replication, bypass-RLS or
memberships. Database-scoped statement/lock defaults are 5s/2s. A role comment and
control row carry the owner's token fingerprint.

Grants allow only schema usage, control-row reads, synthetic budget reads/updates
and guard execution. PUBLIC execution is revoked only on the new guard.
A metadata-only audit refuses inherited foreign table access, schema creation,
foreign sequences, database CREATE, foreign security-definer execution, memberships
or elevated attributes. It reads
no application rows and never changes shared ACLs. Ordinary PUBLIC CONNECT/TEMP
and catalog visibility are not treated as application-table privileges.

## Admission and accounting

Only setup, qualify, catalog and cleanup are admitted. Run, idle samples and
arbitrary actions return 404 before client construction with fully valid
functional credentials. The route imports the new functional module, not the
historical profiler. Proxy still blocks every ordinary application API.

Authorization requires Preview, iad1, a constant-time checked random-token hash,
an issued/expires window of at most 24 hours, and platform VERCEL_GIT_COMMIT_SHA
equal to BENCH61_REVIEWED_SHA. Missing platform provenance stops admission.
Do not fabricate a platform SHA to bypass the check.

DATABASE_URL stays unchanged. BENCH61_DATABASE_URL has the same host, database
and TLS options, with only the new login/password. Unsupported URI options are
refused rather than carrying possible identity overrides. There are no project-wide or
Production environment changes.

Per action: at most 220 HTTP round trips / 440 explicitly submitted SQL
statements, checked before dispatch. Setup submits 13 statements in one trip;
cleanup submits three in one trip. Administrator guarded transactions establish
timeouts in a separate statement before calling the guard, then execute work.
Worker statements use pre-login role defaults without setting a timeout inside
the command.

Internal PL/pgSQL work is additional: each guard takes a transaction fence and
reads one control row; setup runs four dynamic role/default/comment DDL commands;
cleanup reads ownership/activity and drops at most the exact schema and role.
These counts are not latency claims.

## Finite qualification sequence

1. Claim qualify once with a unique request and 300-second lease. Replays and
   concurrent actions are refused. Failed/ambiguous runs keep their lease.
2. Inspect session/current role, database, 5s/2s settings and Read Committed on
   sequential and three concurrent requests; drain all started work on failure.
3. Write a transaction-local synthetic nonce, then require the same backend PID
   without the nonce within five reads. Failure to observe reuse is incomplete
   evidence, not a pass. No worker timeout setting is changed.
4. Require server 57014 with statement-timeout reason on a finite six-second
   sleep. Debit and sleep in one statement, require the same cancellation, and
   verify rollback. Probe elapsed times corroborate server errors; no CI speed
   assertion or performance acceptance uses these timings.
5. Refuse wrong owner/request identities. Hold the exact budget row for four
   seconds in a bounded operator transaction; observe it, require worker 55P03
   with lock-timeout reason, drain the holder and verify unchanged balance.
6. Terminal fixture phase, after earlier work drains: shorten only this request's
   synthetic lease to two seconds and admit a four-second guarded debit.
   Observe expiry by database clock, require cleanup to refuse on the in-flight
   fence, and require late admission to fail. Drain the admitted debit and verify
   exactly one commit (100 -> 97). No later workload is admitted. Completion
   checks the same owner/request even though this fixture lease has expired.
   External cleanup may win after the transaction drains; that stops qualification
   rather than recreating objects or claiming success.
7. Report functional checks only. No performance action or automatic promotion.

The synthetic debit probes timeout/fencing behavior; it is not a production
provider-credit implementation or replacement for previous accounting tests.

## Cleanup and recovery

A single transaction takes the nonblocking exclusive fence, validates present
schema owner/lease and role owner marker, refuses active or redacted worker
activity, drops only the owned schema/role, and confirms absence before commit.
No one-shot cleanup claim is consumed. Repeated absence succeeds; ownership
mismatch, rollback and lost-response recovery are tested.

The receipt records the role OID and session count before removal when known.
Idle provider-pool sessions can outlive role deletion. No sessions are terminated;
an already-absent retry reports unknown historical counts. Inspect residual
sessions and wait for normal expiry. Closing only the owned identity needs
separate consent; never flush pools, kill foreign sessions or use DROP OWNED.

After hosted testing, confirm schema/role absence, delete the exact Preview and
verify URL/control-plane absence, and remove generated credential files.
Failed qualification may require the original five-minute lease to expire.
If permissions or token expiry block recovery, stop for owner-validated operator
cleanup rather than widening permissions.

## Private deployment helper (not executed)

scripts/bench61-deploy.mjs does nothing on import. After separate consent, a
private parent can read the approved Preview URL without printing it and call
writeRuntimeSpec with an outside-checkout absolute path and reviewed SHA. It
replaces the operator login/password, preserves target/options, and creates a
new mode-0600 file containing only the new worker credential, token and public
metadata. It refuses overwrite. No operational credential has been generated.

deployPreparedPreview checks private-file ownership/mode, the exact linked
project/org, clean reviewed HEAD, and at least 30 minutes of cleanup headroom.
CLI 59.10 receives key-only --env flags, resolved from its child environment:
BENCH61_DATABASE_URL, BENCH61_TOKEN_HASH, BENCH61_ISSUED_AT,
BENCH61_EXPIRES_AT and BENCH61_REVIEWED_SHA. No DATABASE_URL override, project
environment update, build-env, raw secret argument, shell, production flag or
alias change is used. Captured output yields only a verified Preview URL/SHA/
expiry; unconfirmed completion stops without retry.

The helper is tested offline; preparing code is not consent to execute it.
Before hosted setup, independently verify deployment SHA, protection, function/
database region and designated resource. Missing Git metadata needs a supported
deployment-provenance decision, not a fabricated system environment variable.

## Validation and next gates

Fixture: PostgreSQL 18.6 / 512 MiB at 127.0.0.1:54361. Every integration
connection is hardcoded to it; external DATABASE_URL is never used for test
connections. Opt-in PG tests remain outside the web compilation graph. No pg
dependency, CI, database-package, pipeline or application-feature changes.

Evidence: docs/evidence/206-profile/local-functional-candidate-receipt.json.
Local transport-adapter results are not managed Neon HTTP evidence.
The fixture role/schema are removed and absence checked after testing.

Commit approval -> owner-run independent review -> fresh push and explicit
hosted role/credential/deployment consent -> actual finite HTTP qualification.
Only then may the owner authorize the separate 20-worker experiment.

Validation completed on Node 24: 951 application tests and 307 Node tests pass;
13 opt-in tests skip by default. Three complete functional PostgreSQL regressions
pass, plus the prior finite role regression. Three offline deployment-helper tests,
root/web typechecks, targeted ESLint, ten import-boundary probes and the production
Turbopack build pass. Later catalog-audit SQL hardening was revalidated by the three
real PostgreSQL tests and production compilation. Operator defaults remain 0/0;
test role, both fixture schemas and the synthetic ACL-probe table are absent;
the 512 MiB fixture is stopped. No operational credential file was generated.
