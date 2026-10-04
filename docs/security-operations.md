# Security operations

Maintainer: `vneilly`. Public reports use the private reporting channel in
[SECURITY.md](../SECURITY.md). The targets below guide internal prioritization;
they are best-effort planning targets, not public acknowledgement or remediation
guarantees. Record availability constraints, mitigations, and review dates for
exceptions.

| Finding | Internal initial response target | Internal action target |
| --- | --- | --- |
| Exposed credential | Investigate immediately | Revoke/rotate immediately; assess access and dependent configuration. |
| Critical vulnerability | Within 24 hours | Mitigate within 24 hours where feasible; document a follow-up if a compatible fix is unavailable. |
| High vulnerability | Within one business day | Fix or record mitigation within seven days. |
| Lower severity | Weekly security triage | Schedule according to exposure and impact. |

## Weekly maintainer checks

1. Review private reports, Dependabot/CodeQL findings, and secret-scanning alerts.
   Keep credentials and sensitive reproduction data out of public evidence.
2. Review the production audit and full development audit separately. Assess
   actual paths and exposure rather than adding dependent-package severity
   counts as if they were distinct advisories. For each retained finding record
   advisory, installed path/version, impact, mitigation, owner, follow-up, and
   review date. Revisit an exception on new information or its review date.
3. Inspect every manual dependency override against owning upstream releases
   and current advisories; use the [dependency checklists](dependency-updates.md).
   Attach the relevant Firebase checklist to real update PRs before approval.
4. Check scheduled-workflow state and the last successful run. Check Collector
   Health even if no failure email arrived: a disabled schedule produces no
   failed run. Revisit ownership when the schedule's cron editor changes.
5. Verify personal security-alert and relevant failed-workflow email/web
   settings in GitHub. Record a dated self-attestation or screenshot with
   personal information removed. Repository settings and PR assignment do not
   establish account notification delivery.

The 2026-10-04 [baseline/dispositions](https://github.com/ven2dev/dfs-ev-demo/issues/59#issuecomment-5978472280)
and [settings/provenance evidence](https://github.com/ven2dev/dfs-ev-demo/issues/59#issuecomment-5978559303)
are snapshots. The latter records enabled Dependabot security updates, secret
scanning, repository push protection, and private reporting. Notification
attestation and the cancelled web-editor block-test evidence remain pending;
they must be recorded separately before #59 is complete.

## Workflow validation and Action updates

Run `actionlint` locally against all three workflows:

```bash
actionlint .github/workflows/ci.yml .github/workflows/codeql.yml .github/workflows/collector-health.yml
git diff --check
```

Use the installed validator or an upstream release with a verified checksum;
record its version and whether its optional ShellCheck integration ran.
`zizmor` is an optional additional permission/injection check. Neither validator
proves that GitHub received CodeQL analysis results.

Every external Action uses a full commit SHA and a same-line release-version
comment. When updating a pin:

1. Read the release tag from the canonical upstream repository. If its object
   type is `tag`, dereference tag objects until reaching the underlying commit.
2. Verify that commit is reachable from an upstream maintained branch, using
   the canonical upstream ref/history. For GitHub's `COMMIT_SHA...main` compare,
   `behind_by: 0` with status `ahead` or `identical` proves `main` contains the
   commit. If a maintained release branch owns the commit instead, verify and
   record that branch. Merely finding a SHA in the fork network is insufficient.
3. Record upstream repository, release tag, commit, and ancestry evidence.
   Provenance is separate from tag signature verification.
4. Run actionlint and the [Node 24 quality contract](../README.md#quality-checks)
   before approving the update. Retain `persist-credentials: false` for
   checkouts that do not push.

CI grants `contents: read`. CodeQL's analysis job grants `contents: read` and
`security-events: write`; add `actions: read` only with a documented need.
Collector Health defaults to no workflow permissions and grants `issues: write`
only to the incident-management job. Its health credentials are separate from
the security-analysis job, which has no application secrets or provider calls.

## CodeQL baseline and required-check rollout

The advanced workflow analyzes `javascript-typescript` with `build-mode: none`
and the standard query suite on PRs to `main`, pushes to `main`, Monday
16:23 UTC, and manual dispatch. It has no source-path filter. Keep
`pull_request` analysis for Dependabot PRs; declared permissions alone do not
prove that the restricted token can upload results.

The bootstrap PR cannot establish an existing main comparison baseline.
Complete rollout in this order:

1. After the owner merges the workflow PR, confirm that the push-to-main run
   uploaded analysis results for that exact merged commit. Record the run URL,
   analyzed SHA, language/category, and initial-alert dispositions.
2. Open a separately approved small PR containing a useful `src` change.
   Confirm the PR analysis uploads and compares against main; do not introduce
   a vulnerability or meaningless source edit to manufacture evidence.
3. Confirm the first genuine Dependabot PR uploads CodeQL results and passes
   ordinary CI under its restricted token. If no update is available, retain
   this as pending instead of manufacturing a dependency change.
4. Read the actual reported CodeQL check name and source from those runs before
   adding it to required checks in `DFS_Main` (ruleset 22423636). Preserve the
   existing `CI` and `Vercel` checks, strict up-to-date policy, PR/thread rules,
   and no bypass actors. Verify enforcement on a subsequent PR. Until this is
   done, CodeQL analysis is advisory; existing CI and Vercel remain required.

Track these post-merge acceptance checks on #59. The bootstrap PR references
the issue without `Closes #59`; keep it open while any required evidence is
pending. Add links and distinguish workflow success from actual analysis upload.

## Disabled schedules and recovery

GitHub can auto-disable public-repository scheduled workflows after 60 days
without repository activity. This affects weekly CodeQL and ten-minute
Collector Health. Once enabled, CodeQL's push-to-main trigger supplies fresh
analysis following new main activity, but do not assume a disabled workflow
has automatically resumed. Collector Health has no push-trigger fallback;
absence of an incident email does not prove monitoring is running.
[GitHub's workflow enablement guidance](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow?tool=cli)
describes recovery.

After the workflow files are on `main`, inspect state and recent runs:

```bash
gh api repos/ven2dev/dfs-ev-demo/actions/workflows/codeql.yml --jq '{id,state,path}'
gh api repos/ven2dev/dfs-ev-demo/actions/workflows/collector-health.yml --jq '{id,state,path}'
gh run list --repo ven2dev/dfs-ev-demo --workflow codeql.yml --all --limit 3 --json databaseId,event,status,conclusion,createdAt,url
gh run list --repo ven2dev/dfs-ev-demo --workflow collector-health.yml --all --limit 3 --json databaseId,event,status,conclusion,createdAt,url
```

If a schedule was disabled by inactivity, re-enable the affected workflow and
dispatch a verification run. First check that Collector Health was not
deliberately disabled for a planned collector shutdown:

```bash
gh workflow enable codeql.yml --repo ven2dev/dfs-ev-demo
gh workflow run codeql.yml --ref main --repo ven2dev/dfs-ev-demo
gh workflow enable collector-health.yml --repo ven2dev/dfs-ev-demo
gh workflow run collector-health.yml --ref main --repo ven2dev/dfs-ev-demo
```

Confirm CodeQL result upload, Collector Health completion/incident disposition,
and a later scheduled run. Document any monitoring gap and recheck notification
ownership. The health check reads the existing health endpoint and may reconcile
an incident issue; it does not trigger paid odds collection. Follow the
[collector operations guide](odds-collector-operations.md#health-monitoring-and-incident-lifecycle)
for operational faults instead of making provider calls to test security tools.
