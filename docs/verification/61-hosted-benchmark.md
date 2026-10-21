# #61 disposable hosted benchmark — review plan

## Purpose and design basis

Pattern: isolated synthetic performance experiment, separate from production application state. Alternatives: local latency alone omits Neon HTTP/scale-to-zero; benchmarking production tables creates unnecessary write/load risk and is rejected. Target: same-region warm paid-boundary check p95 <=50 ms, <=35 ms for 30% headroom in three repeated/interleaved trials. Report cold latency separately. No target is relaxed on a failure.

## Exact boundaries

- Existing Vercel project dfs-ev-demo, Preview only, existing dfs-ev-preview Neon resource (small-pond-10949870). No Production database access during the experiment, and no changes to app tables.
- Proposed dedicated schema: bench61_20261019. Preflight verifies it does not already exist; an existing schema is a stop condition, never dropped/adopted. All benchmark SQL fully qualifies this schema and uses only synthetic account/period rows.
- Throwaway branch feature/dfsEV-61-hosted-budget-benchmark from fresh origin/main, never merged and no PR to main. Owner-approved commits and a fresh per-instance push consent apply. Only Preview deployment is created; no promotion.
- No environment-variable additions/updates, database migrations, project-region changes, cron settings, Production deploys, provider requests or new paid services. The harness reads only the existing Preview database configuration; no secret values enter logs/evidence.
- Minimal benchmark-only page/POST route uses the Neon HTTP driver already installed. It never imports the app's provider code, and never calls external odds APIs. Existing ordinary app API routes on this throwaway deployment will refuse provider-bearing work, preventing accidental navigation from spending credits; this guard lives only on the disposable branch.

## Access controls

Verify existing Vercel Deployment Protection applies to the exact deployment URL, including an unauthenticated request challenge/denial. Stop if it does not; do not weaken protection or silently change project settings. Use the existing authenticated Vercel browser session, not a newly provisioned protection-bypass token.

A separate 256-bit random benchmark token is generated locally and stored in a mode-0600 local temporary file. Only its SHA-256 digest and an expiry (maximum 24 hours) enter throwaway source. The actual token never enters git, a URL, logs or evidence. The protected benchmark page submits it in a POST body; the route checks it in constant time before any database request, then strips it from output. Missing/invalid/expired tokens return 404 and execute zero SQL. The route refuses execution outside VERCEL_ENV=preview and refuses any database hostname other than the verified Preview hostname. No environment-variable change is needed for the additional token.

Only bounded enumerated actions are accepted: setup, warm trial, cold sample, catalog check, cleanup. No arbitrary SQL or identifiers are accepted. Time/count limits are compiled into the harness. This prevents the experiment becoming a general database endpoint.

## Region proof and connection identity

Observed October 19: Settings > Functions selects iad1 (Washington, D.C., us-east-1); Fluid Compute enabled. The Preview resource Settings > Update Configuration reports Region Washington, D.C., USA (East) iad1. Configured region match is confirmed read-only; runtime region and sanitized hostname mapping remain a preflight gate. Before setup, record the actual candidate function region from its runtime metadata and the Preview database's platform region/hostname. Compare mapped regions explicitly; hostname DNS proximity is insufficient. Also compare Production host region metadata read-only if needed to establish representativeness. A mismatch stops the same-region claim; do not silently move infrastructure.

Confirm the existing Preview connection really addresses dfs-ev-preview, not the Production resource. Compare sanitized hostname/resource identity without recording credentials. Prior table matching is not identity proof. Set per-query transaction-local statement_timeout and lock_timeout only for synthetic benchmark operations, with no ALTER ROLE or session-global settings changes; these changes end with the transaction.

## Bounded experiment

Setup: one synthetic budget table and bounded seed rows, <=1 MiB data. Correctness: 1,000 deduction attempts at concurrency 20; 100 credits/floor 20/3-credit attempts; separate collector and invalid/stale/downward-correction cases. No-refund semantics retained; unknown outcomes do not trigger provider sends.

Warm speed: three interleaved baseline/budget trials, 1,000 calls each per mode, concurrency 20. Measure inside the Vercel function around the Neon HTTP call, separate browser-to-function latency, and count network calls. Hard cap 8,000 SQL calls for correctness/warm/metadata total, excluding <=20 bounded setup/cleanup statements. If runtime duration limits require chunking, preserve trial identity and do not conflate a batch SQL call with one public request.

Cold: three samples, each after at least 6 minutes with no benchmark/database queries (longer if observed auto-suspend setting exceeds 5 minutes). Record last-query timestamp, idle interval and sample count. Confirm suspend independently using provider status/monitoring if available without waking compute. Shared traffic may prevent suspend: if not confirmed, label an idle-first-request sample and do not call it cold. Never claim a six-minute wait alone proves suspend. Do not change auto-suspend or interrupt other Preview users. Keep user updates during waits; any tool wait <=60 seconds.

Abort at 30 minutes of active experiment time, first out-of-scope identity/region/protection failure, <=8,020 total SQL calls, or repeated unavailable database. Record partial evidence honestly. No automatic retry of ambiguous writes. The experiment uses included hosting/compute only; no plan upgrade or purchase is authorized.

## Cleanup and verification

After saving sanitized results: DROP SCHEMA bench61_20261019 CASCADE, only if this run created and verified ownership of that exact schema. Confirm SELECT to_regnamespace('bench61_20261019') returns NULL. Show the exact cleanup action and request action-time confirmation where required by the execution tool policy.

Delete only the throwaway Preview deployment created for this experiment, then verify its URL is unavailable. Deployment deletion may require action-time confirmation. Never delete the existing #148 Preview or the project. Owner-approved branch cleanup follows after evidence is retained; do not delete unrelated branches/worktrees.

Evidence contains SHA, tool/runtime/region identities, sanitized database identity, sample counts, per-trial distributions, query counts, failure results, schema-absent receipt and deployment-removal result. No token/connection string, raw app data or large screenshots are committed. Add only compact final evidence to the later approved #61 implementation branch.

## Estimate

1. Harness, local access-control/bounds checks and exact diff review: 1.5 h.
2. Approved Preview setup, region/protection proof, warm/cold run: 1 h active work plus idle intervals.
3. Cleanup, evidence and final roadmap update: 0.5 h.

Three hours active total. Stop for scope review before five hours. The future application roadmap remains gated on measured results and owner approval; this experiment does not authorize production rollout.

## Implementation review — October 21, 2026

Owner approved this experiment and the corrected ceiling of **16,040 explicit SQL
statements / 8,020 HTTP round trips**. Each measured HTTP transaction contains one
transaction-local timeout setup statement and one baseline/deduction statement.
The benchmark's synthetic control row reserves conservative action budgets and
records each enumerated action once; this bounds retries and avoids re-running
an ambiguous write. These bookkeeping transactions are counted but excluded
from individual warm-sample durations. No application accounting schema is frozen.

- Fresh base: `c59cff1`; throwaway branch `feature/dfsEV-61-hosted-budget-benchmark`.
- Vercel CLI reports existing SSO protection `all_except_custom_domains`, Fluid
  Compute, function region `iad1`, and Node 24. No protection or settings changes.
- Vercel resource settings confirm `dfs-ev-preview`, `small-pond-10949870`, `iad1`.
  Its existing Preview PGHOST is compiled as the exact hostname guard. Runtime
  identity/protection checks still precede hosted setup.
- The additional token is local-only, mode 0600; only its SHA-256 digest and
  expiry are in source. Expiry can require regeneration before an approved push.
- Every ordinary `/api/*` route is blocked on this deployment, leaving only
  `/api/bench61`; no provider code is imported by the harness.
- Cold actions time their first HTTP transaction, including the owned-run claim
  and budget check. They enforce at least six minutes since the preceding query.
  A five-minute quota may correctly be stale after that interval. Suspended
  compute still needs independent confirmation; otherwise report idle-first-request
  samples, never confirmed cold samples.
- Access controls, replay refusal, existing-schema refusal, target-scale SQL and
  owned-schema cleanup were tested locally on PostgreSQL 18.6 / 512 MiB.

No hosted schema, deployment or provider request has been created at this stage.
The branch is never merged. Commit approval, owner review and fresh push consent
precede deployment; the existing Production environment remains outside scope.

Final local checks: 5/5 tests passed with the opt-in real PostgreSQL fixture,
TypeScript and targeted ESLint passed, and the production build passed after
removing Next 16.4's deprecated `preferredRegion` export. The operator page at
localhost returned 404 “Denied before SQL” with no token. The ordinary API block
is limited to this disposable branch. No remote benchmark has run.
