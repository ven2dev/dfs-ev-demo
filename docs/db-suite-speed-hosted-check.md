# #153 hosted feasibility check — stop for decision

**The ≤150-second target is not proven. Stop before A/B.** Both hosted DB jobs passed every required case, but one took 155 seconds. The target is unchanged.

| Hosted event | Full DB job | Suite step, including PostgreSQL lifecycle | Inner overlapping runner | Install | Result |
|---|---:|---:|---:|---:|---|
| [Push run](https://github.com/ven2dev/dfs-ev-demo/actions/runs/39093146277) | **155 s** | 116 s | 105.34 s | 22 s | DB passed; exceeds target by 5 s |
| [Draft-PR run](https://github.com/ven2dev/dfs-ev-demo/actions/runs/39093164119) | **118 s** | 90 s | 78.71 s | 15 s | DB passed; below target by 32 s |

Both runners reported `os.availableParallelism() === 4`. The CPU-derived limits were three scratch workers and one Node-test worker. Both verified 75 Node cases and all 136 Vitest cases: 13 lease, 4 readiness, 111 predictive/source and 8 corpus. Test declarations and required-case validators were unchanged. The 37-second job spread includes a 26-second difference inside the suite step, so installation alone does not explain it. The cause of the runtime variation was not established.

The only prototype changes were the requested CPU-derived concurrency bounds and temporary CI wiring: a throwaway-branch push trigger, profiling file paths and printing the existing timing output. No production cleanup, template-builder changes, test rewrites or tuning were introduced. One push supplied both requested measurements; there was no follow-up push.

Both events used prototype head `36968fa9cbed9a59210d5b50c0f2aba5f362600a`. The push checked out that exact commit. The PR used merge checkout `c1fc1aacf1595a42ba3f9401d2a27a1ab67b707c`, incorporating main's newly merged #161 UI/library refactor (`4e13c0f`). That main update changed no DB tests, DB scripts, dependency lockfile or DB workflow. These were not identical whole-repository checkout trees; this qualification is retained rather than treating the timing difference as a controlled hardware-only experiment.

App checks failed lint on the prototype's temporary explicit `any` annotations. Consequently aggregate CI was red in both runs. The successful DB measurements are not a production-ready green CI result.

## Decision and roadmap

The local improvement translates into a substantial hosted improvement over the prior 361-second DB job, but it does not reliably establish 150 seconds or the engineering standard's 30% benchmark headroom. The hosted check therefore does not authorize implementation under the owner's conditional roadmap.

Owner decision: retain 150 seconds and approve another bounded feasibility check (for example CI job sharding), or explicitly revise the target. No extra spike, sharding, softer target, A/B implementation or new push has been assumed.

Per the owner's updated preference, A (verified templates, three-hour cap) and B (balanced files/overlapping lanes plus CI proof, three-hour cap) are **two commit steps on #153, not new issues**. Neither has started. Each implementation commit remains owner-approval gated; each subsequent push needs fresh consent; no merge.

## Cleanup and evidence

[Draft PR #162](https://github.com/ven2dev/dfs-ev-demo/pull/162) is closed without merging. The remote and local throwaway branches are deleted. The original #153 worktree is restored at `12290d8`, with no tracked source changes. The prototype commit was disposable and is preserved as a local evidence patch; no A/B implementation commit exists. The temporary trigger was only on the deleted branch and was never added to main.

The check completed in about six minutes, within the 20–30 minute limit. [Evidence JSON](evidence/db-suite-speed-hosted-2026-10-17/evidence.json), full DB logs, app-failure log, job metadata and the exact hosted prototype patch are saved beside this report. No evidence commit or second push was made.
