# #61 finite HTTP timeout qualification

Status: local Git-source deployment correction after 9f3091c, awaiting commit
approval and independent review. The prior approved Preview attempt returned an
admission 404 before SQL; it did not qualify managed HTTP behavior. Both temporary
deployments were removed, schema/role absence was confirmed, and the generated
credential file was deleted. The exact rejected admission condition is unproven.
No further push or deployment is approved. This branch never opens a PR or merges.
Permanent implementation and performance execution remain blocked.

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
Database: neondb. Both runtime validation and deployment preparation read the
expected host/database from bench61-config.json. URI-decoded database names
must match that reviewed value; agreement between two wrong URLs is insufficient.
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
A metadata-only audit refuses inherited foreign table access, including column-only
SELECT/INSERT/UPDATE/REFERENCES grants checked with has_any_column_privilege, schema creation,
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

## Private deployment helper (local correction, not executed)

Pattern: provider-backed Git-source deployment pinned to an immutable reviewed SHA.
The fixed GitHub repository is 1350991998 and the fixed non-production branch is
feature/dfsEV-206-budget-latency-profile. The deployment request specifies both
ref and SHA, so a later branch update cannot silently substitute source.
Alternatives: injecting VERCEL_GIT_COMMIT_SHA would self-assert provenance;
removing that guard would permit unreviewed setup; repeating an opaque CLI upload
provides no diagnostic improvement. All three are rejected. This transport change
does not establish which admission condition rejected the previous deployment.

scripts/bench61-deploy.mjs does nothing on import. A private parent may call
writeRuntimeSpec with the approved Preview operator URL and reviewed SHA. The
new mode-0600 outside-checkout file contains only the generated worker credential,
benchmark token and public metadata. Preparation refuses overwrite and retains
all target/database/TLS checks. No credential has been generated for this correction.

deployPreparedPreview(file, accessToken) requires a caller-supplied existing
Vercel access credential in memory. The helper does not obtain, store, return or
log that credential. It checks file ownership/mode, exact linked project/org,
clean reviewed HEAD and at least 30 minutes of cleanup headroom. It sends exactly
one POST to https://api.vercel.com/v13/deployments with the fixed teamId. Only the
five existing BENCH61 runtime keys are in the deployment env body; DATABASE_URL
is inherited without override. No system SHA, project settings, project env,
production target, alias, source upload, or mutable latest-commit field is sent.
The API's deployment-level env follows the installed official CLI's create payload.
The project remains Git-linked and system-variable exposure is already enabled;
no setting change is part of this correction.

The POST uses direct fetch, a 60-second AbortSignal and redirect:error. The
installed CLI59.10 api command uses a retrying client, so it is deliberately not
used for this create. No create retry occurs on timeout, transport failure,
non-success response, malformed JSON, or unexpected response identity. Such
ambiguity requires read-only inspection before any separately approved retry.
Credentials travel only through memory and TLS, never argv or operational logs.

The response must identify the designated project, a disposable URL/id,
non-production target and githubCommitSha equal to the reviewed SHA. The returned
receipt explicitly says ready:false: creation is not build readiness or successful
runtime qualification. Inspect actual SHA, protection, function/database region
and deployment status before using it. Enter the benchmark token with paste/type
input so the controlled React field receives input events. Require catalog success
before setup. If admission still fails, stop without SQL, clean up and investigate;
do not fabricate a system SHA or weaken admission. No public diagnostic route added.

Sources: [Vercel create-deployment API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment),
[system variables](https://vercel.com/docs/environment-variables/system-environment-variables),
and installed CLI59.10 deploy/api source. Offline tests cover exact source/env
scope, private files, deadline/redirect policy, one attempt, redacted failures and
response provenance. The unchanged functional budgets are 220 trips/440 submitted
SQL statements per action; performance remains disabled and 50/35 ms future targets
remain unchanged.

## Validation and next gates

Fixture: PostgreSQL 18.6 / 512 MiB at 127.0.0.1:54361. Every integration
connection is hardcoded to it; external DATABASE_URL is never used for test
connections. Opt-in PG tests remain outside the web compilation graph. No pg
dependency, CI, database-package, pipeline or application-feature changes.

Original-candidate evidence: docs/evidence/206-profile/local-functional-candidate-receipt.json.
Correction evidence: docs/evidence/206-profile/local-review-fixes-receipt.json.
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

## Review corrections after 4e1d18d

P1: the foreign-table audit now checks table privileges OR any column privileges.
The PostgreSQL regression grants only SELECT(secret) to PUBLIC, verifies table
SELECT is false while column SELECT and a direct synthetic diagnostic read work,
and requires qualification to stop before any worker probe. The unchanged
synthetic balance and inherited grant confirm no probe writes or ACL rewrites.

P2: database neondb is pinned in the reviewed JSON alongside the host. Both
createRuntimeSpec and validateRuntimeSpec check the decoded database, as does
functionalIdentity for each runtime URL. Tests reject consistently matching
ordinary_app_db URLs before client construction or credential preparation and
accept percent-encoded spelling of the expected name.

The full-suite/build counts above describe the original candidate. Correction
checks are recorded separately: 18 focused server tests, four deployment-helper
tests, four finite PostgreSQL regressions, root/web typechecks, targeted ESLint,
import-boundary probes and whitespace checks. The ten older PostgreSQL tests
containing profiling workloads are deliberately unselected. No hosted mutation,
credential-file preparation, push, deployment or performance run is authorized
by these fixes.

## Git-source correction validation

Six offline deployment-helper tests pass on Node24. The correction changes only
the helper, its offline tests and this runbook. It does not modify application
admission, database SQL, timeouts, cleanup fencing, dependencies or CI. No hosted
request or operational credential preparation was used to validate the correction.
Commit, independent review, push and hosted deployment remain separate gates.
