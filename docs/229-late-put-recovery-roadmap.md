# #229 — mandatory-owner late-PUT recovery (approved with backoff amendment)

Status: owner-approved November 2, 2026, subject to the measured backoff amendment below. Implementation proceeds per-step; no commit or push without approval.

## Design basis

Pattern: single-owner garbage collection with a retained recovery horizon and
existing per-address transaction advisory lock. Extend the existing removal row;
keep pending and recovery pages separate, pending first. No new table/scheduler.
Alternatives: co-own with orphan GC (conflicting grace/completion); fence uploads
(changes the approved ObjectStore contract); new scheduling subsystem (unneeded
if a second bounded predicate on the existing queue works). A single mixed LIMIT
is rejected because completed recovery rows could displace pending removals.
Targets: 1,024 pending candidates plus at most 1,024 recovery candidates per
invocation; no recovery selection in the pending lane. Proposed measured client budget: 2 + 4P + 4R statements,
P,R <=1,024, maximum 8,194; refused/adoption-only candidates may use fewer. No elapsed-time target exists in #229; local timings are
context, not a new acceptance threshold or hosted claim.
Assumptions: trusted pipeline, local ObjectStore, PUT completion within 24 hours,
300-second orphan grace, no fencing; preserve any longer mandatory grace.
Permanent tombstones prevent re-publication of identically addressed content.
Sorted address locks preserve deletion/publication ordering and avoid deadlocks.

## Owner decisions

1. Owner agreed: latest actual orphan enrollment +24 hours; no restart at
   handoff or scans.
2. Owner agreed: exponential revisit backoff: 60s, 120s, 240s, doubling up to a
   one-hour cap, with the final due timestamp clipped exactly to the fixed
   24-hour horizon. Actual opportunities depend on cleaner invocation
   frequency; this issue adds no scheduler or wall-clock service guarantee.
3. Owner agreed: preserve shared-live-reference refusal and re-arm semantics;
   mandatory ownership never authorizes deleting another live reference.

The shared-reference behavior preserves #166 safety semantics.

## Intake findings

#166 is on main through PR #230. Existing queue has completed_at/outcome but no
recovery metadata. Current query excludes observations and completed rows before
LIMIT. Its *unchanged* predicate cannot revisit completed removals. A second
bounded page on the same table can carry the predicate; spike below tests this
before any new subsystem is considered. Pending must run first so it cannot be
starved by recovery work. #164 discardUnpublishedReport currently checks registry
only: it must defer to a tombstone after locking. orphan_recheck's model branch
also needs a mandatory-owner check before deleting or retiring an observation.

Prototype SQL is deliberately admin-only, not production permission/role code.
It tests scheduling/handoff primitives against the real #138/#165/#166 schema.
Full authorization, shared-reference and failure matrix belong in the approved
implementation, not assertions inferred from synthetic queue measurements.

## Spike results and limits

The proposal adds recovery_until/recovery_due to the existing removal row and
uses the existing address lock. Handoff transfers latest enrollment +24h and
preserves max(mandatory grace, enrollment +300s), then deletes the observation in
the same transaction. Repeat scans/adoption do not extend the horizon. A repeat
deletion can extend its mandatory grace without resetting recovery metadata.

The unchanged queue predicate cannot carry completed recovery. The *same table*
can: retain the pending page, add one bounded recovery/adoption page joining
orphan observations for pre-existing rows, including completed rows. No new table
or scheduler is needed. The prototype's recovery index is not a promise that the
mixed observation predicate is index-only; assess actual plans at the fixture.

Measured on the real #138/#163/#165/#166 schema and standard local PostgreSQL
18.6 fixture: pending 1,024+2 page progress despite 1,025 observed addresses;
pre-existing observation adoption 1,024+1; completed recovery 1,024+1. Each full
allowed pending/recovery page executed 4,097 client statements and 1,024 actual
idempotent local ObjectStore DELETEs. Thus the proposed maximum is 8,194 client
statements and 2,048 DELETE calls per invocation, with zero GET/HEAD/LIST/PUT in
the cleanup loops. Two empty selections cost two statements. BEGIN/COMMIT count;
function-internal statements do not vanish from server-work review.

Actual local bytes validated absent-then-late arrival and unlink-before-ack
rollback/resume. Both actual address-lock orders were observed through
pg_blocking_pids. Final expired revisit cleared scheduling metadata only.
Six alternating selection trials are in the receipt; timings are contextual.

Limits: queue controls do not prove live dependency graph permissions; full
paused-PUT/publication/rights races remain implementation tests. Prototype APIs
are admin-only and not application APIs. Existing tombstone publication refusal
was inspected, not retested through a full publication envelope in this spike.
These limits prevent presenting the scheduling spike as completed #229 delivery.

## Atomic roadmap and LOE

Total estimate **4.5–5 engineering hours including intake/spike**, hard stop at
five hours. Roughly 0.75–1 hour is intake/spike; the remainder is implementation
and verification after approval. Stop with evidence and propose a split if the
remaining work no longer fits. The approved issue branch is created from fresh main.

1. **Transfer ownership in proposal SQL (0.75–1h).** Extend the existing removal
   row; integrate adoption into deletion's existing sorted address-lock phase
   and bounded lazy adoption for pre-existing rows. Preserve horizon and both
   grace deadlines. Add same-lock mandatory-owner refusal to orphan_recheck,
   retire_model_observation and #164 discard cleanup. Preserve the tombstone and
   existing writer-only mutation surface; tests use real restricted logins.
2. **Bounded recovery adapter (0.5–0.75h).** Pending lane first, unchanged limit;
   separate recovery/adoption selection <=1,024. Recheck under lock, delete
   idempotently, then acknowledge/advance backoff in the same transaction.
   Start at 60s and double to a 3,600s cap; next due is the earlier of that delay
   and recovery_until. Persist the capped step; scans and repeated deletion events
   never reset it. Backoff advances only after a committed revisit, so a crash
   cannot skip the final deletion attempt. Due time is not a scheduler guarantee: a
   delayed invocation performs the final revisit after the horizon before retiring.
   Adoption-only pending rows become eligible for the next pending page; they
   do not bypass grace. Shared references are never deleted: recheck advances
   their revisit scheduling or retires expired metadata so they cannot pin the
   first recovery page forever. Final expired revisit deletes eligible bytes
   before retiring metadata. Preserve existing connection-interruption policy.
3. **Behavior and races (1.25h).** Implement every matrix row below, with controlled
   barriers and observed lock waits; no sleep-only race assertions. Compare
   server table counters as well as client counts, including ack's recheck.
4. **Validation and review checkpoint (0.75–1h).** Run feature-store and both
   standard PostgreSQL suites, typecheck, lint, catalog/readiness and boundaries;
   compare frozen hashes and existing case inventories. Save compact evidence,
   full logs outside Git. Independent review before separately approved push.

Each implementation step ends at owner commit approval. No migration is frozen
before measured behavior/work proof. All SQL changes remain proposals here.

## Acceptance test matrix

| Acceptance/probe | Required implementation test |
|---|---|
| Common-lock handoff | Deletion adopts observation atomically; both lock orders, orphan-first and handoff-first, prove a single owner and no deadlock. Include #164 cleanup waiting behind handoff. |
| Paused PUT across handoff | Enroll, pause real local PUT before completion, adopt and complete mandatory removal, resume PUT/lost response, revisit reclaims bytes; publication still refused. |
| Absent then late | Completed removal sees absent bytes, retains horizon, later arrival is deleted by mandatory owner, never re-enrolled. |
| Monotone finite horizon | Retry enrollment before handoff sets latest start; repeated deletion/adoption/scans never shorten or endlessly extend horizon; longer mandatory grace still wins. |
| Unlink before ack crash | Delete succeeds, transaction/socket fails before ack; fresh connection resumes idempotently with tombstone/horizon intact. Include unknown COMMIT outcome handling. |
| Backoff | SQL schedule proves 60/120/240/480/960/1920/3600s, cap and final due exactly at horizon; delayed invocation and crash rollback cannot skip final revisit; repeated scans/events cannot reset backoff. |
| Recovery expiry | Boundary before/at/after horizon; final authorized delete then retire only schedule metadata; identical content remains publication-refused. |
| #174 progress | 1,025 observed +1,025 genuinely shared live addresses +later removable target, plus >1,024 recovery candidates; independent bounded lanes, shared attempts cannot monopolize either page. |
| Existing-row rollout | Pending and completed observed rows predating #229 are discovered/adopted in bounded work without a new table/full address walk. |
| Grace/shared safety | Pending owner cannot bypass grace; live model/raw/dataset references survive both lanes and repeated events re-arm as before. |
| Permissions/work | Reader/outsider/direct mutations refused; bad keys rejected; <=2+4P+4R client statements, no cleanup GET/HEAD/LIST/PUT; internal counters show no example/member scans. |

## Non-goals and review gate

No fencing/upload deadlines, new scheduler, hosted writes, UI, frozen migration
changes, or changes to invalidation closure. #86 does not block this local work.
Owner approved proceeding after these changes; post the amended measured roadmap
and use feature/dfsEV-229-mandatory-recovery. Push and merge gates remain
separate. No action on the never-merge hosted harness is implied.

## Measured backoff amendment

SQL virtual-time schedule gives **29 revisits** across a full
24-hour window (excluding the initial removal), including exactly one final due
at 86,400 seconds. No interval exceeds one hour. Shorter remaining horizons
produce fewer revisits. The prior late-arrival, crash/resume, both-lock-order and
1,024-page proofs pass unchanged; the 8,194-statement bound is unchanged.
A delayed worker can leave bytes longer than an hour; this issue adds no scheduler
SLA. The tombstone continues to refuse publication throughout.

## Step 1 checkpoint — November 2, 2026

Ownership transfer is implemented locally in `229_mandatory_recovery.sql`: an
AFTER queue INSERT/event-update trigger adopts observations atomically, including
UPSERT conflicts; a validated writer-only helper handles old rows. Horizon and
grace are preserved, rollback retains the observation, and orphan retirement and
#164 cleanup defer under the common lock. Live shared references remain retained.
10 new PostgreSQL checks, 26 existing orphan/cleaner checks, 23 boundary/layout
checks, normal root typecheck and focused lint pass. Frozen assets are unchanged.
Recovery selection/execution and backoff persistence are Step 2; the amended
spike proves the schedule but this checkpoint does not claim that adapter is done.
No commit or push yet; owner commit approval is the next gate.
