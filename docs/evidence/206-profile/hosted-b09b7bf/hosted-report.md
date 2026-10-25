# #61 / #206 hosted finite HTTP qualification

Reviewed/pushed SHA: b09b7bfca7c5322a37a348238b42f5f98e3a6560.
Disposable protected Git-source Preview: dpl_8xTy1wrYE8DiRJdHKFyZgBgByknC.
Both reviewed/platform SHA match; Preview target; iad1; fixed Preview host/database
neondb. Project system-variable exposure and Deployment Protection were checked.
Five deployment env/build.env values were supplied with owner consent. No project
variables, Production, existing role defaults or shared ACLs were changed.

## Outcome

Finite managed Neon HTTP qualification passed (HTTP200). Six reported identities
used the dedicated limited login in neondb, Read Committed, statement_timeout5s,
lock_timeout2s. Transaction-local nonce was absent on reuse of backend1192.
Server statement cancellation:5007.55ms. Debit+sleep cancellation:5010.69ms;
rollback preserved balance. Lock cancellation:2011.50ms. Qualification only reports
these timings to corroborate server error reasons, not as latency acceptance.

Wrong-owner/request rejection, lease-expiry rejection, cleanup refusal while an
admitted transaction remained in flight, and exactly-once admitted synthetic debit
all passed. Code returns success only after the effective privilege audit and
all probes pass. Qualification used45 HTTP round trips/85 submitted SQL statements,
under220/440 caps. Browser total18625.6ms. No20-worker/performance action or
provider call ran. Permanent #61 implementation remains blocked on performance.

## Actual sequence and process correction

1. The first catalog request returned503 after passing admission. Inspection
   showed catalog uses the synthetic guard/control table and cannot run before
   setup. It is not an independent pre-setup read-only preflight. The old written
   'catalog success before setup' sequence is therefore impossible for this code.
2. Read-only operator check confirmed schema and role absent. Existing approved
   atomic setup then returned200 (1trip/13statements).
3. Catalog after setup returned200 (3trips/9statements), PostgreSQL18.6 and one
   synthetic row. No application data read.
4. One qualify action returned200 with all functional flags true.
5. Cleanup returned200 (1trip/3statements), schema/role absent, roleOID40960,
   workerSessionsBeforeDrop2, sessionsTerminated:false.

The failed first catalog and corrected order are disclosed; do not rewrite them
as a successful pre-setup check. Update the runbook at the next approved local
change. Runtime admission was proven before setup by the503 SQL-stage response;
no admission protection or SQL code was bypassed or weakened.

## Cleanup and review

Both the experiment Preview and push-triggered same-SHA Preview
(dpl_3hDrndPDJcghskmVEXobSeHkrxTS) were deleted. Control-plane404 and both URL404
are recorded. Private generated credential file removed; browser password field
cleared and in-memory private spec released. No rebuild/redeploy/promotion occurred
after setup created the role. An attempted tab close was interrupted by user
browser activity; no further browser control was attempted.

Initial post-drop read-only inspection: two sessions for removed roleOID40960,
zero active, zero unknown. No sessions were terminated; follow-up normal-expiry
observation is recorded separately. Do not claim zero residual sessions without
that evidence.

Artifacts: b09b7bf-functional-results.json (all five HTTP outcomes),
b09b7bf-cleanup-receipt.json (deployment deletion/credential removal), raw browser
AX evidence and a token-cleared screenshot. These remain outside git pending
review. Screenshot shows the page, not all result JSON; use structured JSON as
primary evidence.

Next: independent review of this evidence and the sequencing correction. Only
then an owner decision on a separately scoped20-worker candidate/benchmark.
Keep50ms p95 and35ms headroom unchanged. A functional pass is not performance
acceptance, and the historical profiler remains unrouted.

Follow-up after waiting: two residual pool sessions remain, zero active/unknown.
Role/schema are absent; sessions were not terminated. Normal expiry has not yet
been observed. Record this cleanup limit explicitly in the review.
