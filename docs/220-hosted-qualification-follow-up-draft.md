# Draft: qualify #220 admission on immutable iad1 and pdx1 Previews

Local issue-body draft for owner review. No GitHub issue has been created.

## Description

Qualify #220's atomic leader/GCRA/budget hot path through real Vercel functions
and the Neon HTTP driver, comparing current Production topology (iad1 functions,
us-west-2 database) with a pdx1 co-located candidate. This is a disposable
experiment related to #61 and #220, with no Production implementation or region
change. LOE: **3.5–5.5 active engineering hours**, excluding access/support waits;
hard stop at 5.5 hours. Reserve time for verified cleanup. Split again before
accepting any revised estimate above six hours.

Design basis: paired topology comparison, alternating AB/BA arm blocks, one
external request per function invocation and one fixed sample ticket per request.
Reject concurrent arms because they would contend with one another, and reject
all-A-then-all-B because time drift could bias the comparison. Git-push Previews
from two commits retain branch-scoped Secret delivery; CLI-only configuration
is rejected because that variable scope is not guaranteed. The reviewed local
plan is docs/220-hosted-qualification-plan.md on the never-merge harness branch.

Blocked until the owner-selected support request restores access to Neon project
wandering-tree-67967407 and actual Production branch/endpoint, compute range,
autoscaling and suspend settings are verified. Vercel's store settings expose
region/plan but not those compute settings. No separate Neon project is allowed.
Creating this issue does not authorize sending support messages, committing,
pushing, provisioning or running the experiment; those gates remain with owner.

## Acceptance Criteria

- [ ] Restore verified control-plane access through the support path and record
  Production parity metadata, without credentials in evidence. Confirm the
  Production host's us-west-2 region; do not substitute the recovery/Preview DB.
- [ ] Obtain explicit owner approval for commits, hosted setup/run and the branch
  pushes that trigger Git Preview deployments. Use only
  feature/dfsEV-220-hosted-harness, cut from f806e73, never merged. The proxy would
  otherwise add an invocation to every Production /api request, including SSE.
- [ ] Create one schema-only child in the same Neon project with matching compute
  and suspend settings; verify no Production application rows were copied. Do
  not enable Neon–Vercel per-Preview branching. Limit the runner to spike220;
  audit inherited privileges and verify server timeouts before first SQL.
- [ ] Commit A has apps/web/vercel.json regions ["iad1"]. Commit B changes only
  that file's regions to ["pdx1"]. Verify the exact A..B diff. Record distinct
  expected SHA_A/SHA_B pins in the external runner receipt, not self-referential
  tracked source. No CLI deployment or alternate region config is used.
- [ ] Before each approved push, configure only exact-branch Preview Sensitive/
  Secret variables for that arm/run/SHA. Verify actual scope and write-only
  metadata; stop if Hobby rejects the required capability. Push A, wait for its
  immutable Git Preview to be ready, then prepare and push B. Keep both live.
- [ ] Verify both Git deployment sources, project/branch, expected SHA, exact
  immutable URL/ID, Deployment Protection, runtime/driver/connection parity and
  actual function region from deployment metadata. Neither vercel.json nor the
  moving branch alias is sufficient proof. Confirm both captured arm bindings.
- [ ] Use outer Deployment Protection with approved Automation Bypass, then the
  inner feature flag and one-time bearer. Keep credentials in per-arm 0600 files
  outside Git; never expose passwords, DSNs, bearer or bypass in evidence/logs.
  Verify missing/incorrect gates deny access and ordinary API/cron paths are
  blocked on the harness deployments. Production variables stay untouched.
- [ ] Run the identical 18,483-ticket matrix per arm on the 240-key synthetic
  fixture: one and 20 leaders, three mode orders/rounds, 20 warm-up then 1,000
  timed samples per mode/group, plus cold and stale/next-tick samples. Generate
  20 concurrent requests on the owner's Mac, never inside one invocation.
  Alternate paired arm blocks, drain before resets, and activate only one run
  at a time. Treat lost responses as failures without automatic write retry.
- [ ] Report each arm and mode separately. Require p95 <=140 ms in every
  20-leader warm round and overall warm p95 <=200 ms. Record p99/max as information
  only. Use in-function pre-provider time as the result; client RTT is context.
  A miss stays a miss and blocks permanent work; do not relax targets.
- [ ] Record per-query round-trip times and a standalone SELECT 1 through the
  same driver after non-cold baseline measurements. Preserve documented SQL
  budgets: warm admission 1+release, full path 2+release, baseline 1+transport
  probe, cold baseline 1; accepted stale probe 5+release and one free /events.
  Make no paid provider call. Do not subtract percentiles to claim server CPU.
- [ ] Report cold and stale results separately per arm. Independently verify
  suspension before each cold sample; if Production disables it, report N/A.
  Preserve stale/next-tick state, immediate follower returns and no polling.
- [ ] Save compact sanitized receipts with SHA/run/deployment/region identities,
  correctness, latency, work budgets and limitations. Retain detailed logs outside
  Git. Return results for owner review whether the candidate passes or fails;
  a synthetic pdx1 win is not approval to move existing Production routes.
- [ ] Verify removal of the exact Neon child/role, branch-scoped variables, both
  immutable Preview deployments and local secret files. Keep exact-ID receipts
  sufficient for interrupted cleanup; do not use broad-prefix deletion.

## Non-Goals

- Production function-region changes, route rollouts, scheduling, enforcement,
  released migrations, real paid-provider traffic, or merging the harness.
- A new Vercel project, separate Neon project, moving the existing Preview store,
  enabling project-wide per-Preview branching, or altering Production secrets.
- Fixing #221–#224, including permanent unresolved-liability expiry, operator
  resets or health routes; their existing acceptance gates remain in force.
- Sending the support request or creating this GitHub issue during local review.
- Reusing this benchmark as before/after proof for existing routes. A Production
  region proposal needs its own issue and measurements if pdx1 qualifies.
