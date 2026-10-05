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
scanning, repository push protection, and private reporting. Account notification
settings and the cancelled web-editor block test were verified on 2026-10-04;
see the verification snapshot below and #59 for subsequent rollout evidence.

### Optional secret-scanning settings

Decision for #59: leave non-provider pattern detection and optional provider
validity checks disabled. Keep provider-pattern scanning and push protection
enabled. Non-provider patterns broaden detection to generic keys and connection
strings; defer enabling that category until its alert volume and triage policy
can be assessed. This leaves a detection gap for generic credentials, so use
the existing credential-handling rules and include generic-secret exposure in
manual review. Reconsider the setting during weekly security triage.

Optional validity checks may contact a credential's issuing service. Handle a
suspected exposure through manual investigation and revocation/rotation,
without enabling additional automatic verification requests in this ticket.
An unknown validity status is not evidence that a credential is safe. This
decision concerns the optional repository setting; GitHub's existing provider
partner notifications and built-in GitHub-token checks may still occur.
See [detection capabilities](https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns)
and [validity checks](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning).

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

Concurrency cancels superseded runs only for the same PR. Push, schedule, and
dispatch runs have separate groups per run and do not cancel one another,
including pending runs, so each main commit can establish its own baseline.

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
4. Verify a real fork PR on this public repository uploads results using its
   read-only token and no application secrets. Record approval requirements,
   workflow run, analyzed SHA, and uploaded analysis. Do not switch to
   `pull_request_target` to execute fork code with elevated permissions.
5. Read the actual reported CodeQL check name and source from those runs before
   adding it to required checks in `DFS_Main` (ruleset 22423636). Preserve the
   existing `CI` and `Vercel` checks, strict up-to-date policy, PR/thread rules,
   and no bypass actors. Verify enforcement on a subsequent PR. Until this is
   done, CodeQL analysis is advisory; existing CI and Vercel remain required.

After the configuration reaches the default branch, also record GitHub's
acceptance of `dependabot.yml`, successful update jobs, and actual grouping
and assignment. Local YAML/schema checks cannot supply this acceptance evidence.

Track these post-merge acceptance checks on #59. Use `Refs #59` in the bootstrap
PR and explicitly explain that this is an intentional exception to the usual
`Closes #N` convention: required evidence remains pending after merge. Keep
the issue open through those checks. Add links and distinguish workflow success
from actual analysis upload.

### Verified uploads and remaining rollout

Post-merge evidence is recorded on [#59](https://github.com/ven2dev/dfs-ev-demo/issues/59#issuecomment-5986299912).
The following analyses uploaded without errors in category
`/language:javascript-typescript`:

| Analysis | Ref/commit | Results |
| --- | --- | --- |
| 1890203567 | Initial main baseline, `d577f42` (#73) | Three request-forgery findings |
| 1890204354 | Genuine Dependabot #72 merge ref, `92b4a1b` | Restricted-token upload verified |
| 1890266990 | Useful source PR #79 merge ref, `1d055fc` | Zero findings |
| 1890304078 | Main after #79, `5f934ae` | Zero findings |
| 1890311950 | Main after #72, `9a217b5` | Zero findings |

All three original request-forgery alerts are now marked fixed on main.
The open Dependabot alert query returned no alerts after #72 merged; that
does not replace the separate production and full development npm audits.
GitHub has also processed the default-branch Dependabot configuration and
opened five routine grouped PRs (#74–#78), assigned to `vneilly`.

The observed analysis job check is `CodeQL (javascript-typescript)`, reported
by the `github-actions` app (integration ID 15368). The separately reported
`CodeQL` check belongs to `github-advanced-security` (ID 57789); these are
distinct checks. Require the observed analysis job after fork upload is proven,
and preserve the existing CI/Vercel requirements and strict up-to-date policy.

Notification evidence: direct observation and a session screenshot of the
authenticated owner's account settings showed Dependabot alerts enabled on
GitHub, email, and CLI; weekly Dependabot digest emails; and Actions email
notifications for failed workflows only. The owner also checked the Dependabot
preferences and confirmed they looked correct. This verifies preferences,
not end-to-end email delivery. Personal email addresses are omitted from
public evidence.

Push-protection evidence: a temporary web-editor submission using GitHub's
official dummy was blocked with the wording "Secret scanning found a GitHub
Secret Scanning secret on line 1." The submission was cancelled, the editor
cleared, and unsaved changes discarded. No bypass was selected, no test branch
or commit was created, and the main SHA stayed `9a217b5`. The open secret-alert
query remained empty. Never copy the dummy value into this record.

At this snapshot, fork upload and required-check enforcement remain pending.
The public fork `vneilly/dfs-ev-demo` was created for a useful runbook-update PR;
no application code, dependency, or workflow permission changes are needed.
The repository's fork approval policy is `first_time_contributors`. Record the
fork run's actual token permissions and uploaded analysis, then apply and read
back the required-check rule. Record enforcement on the open PR before declaring
rollout complete. Use #59's latest evidence for the current completion status.

## Odds provider request validation

The initial main baseline raised three `js/request-forgery` alerts at the
Odds API fetch sites. URL parsing confirmed that unrestricted path inputs
could alter the provider endpoint or query. The initial origin was fixed;
arbitrary-host access and exploitable provider redirects were not established.
Do not dismiss the alerts based solely on that fixed origin.

The follow-up validates requests at both the public route and provider
boundaries. Only `americanfootball_nfl` is accepted, and accepted sport input
resolves to that constant. Event IDs are opaque tokens of 1–128 ASCII letters,
digits, underscores, or hyphens; fixture IDs follow the same contract. Markets
must resolve to the player-prop capability registry. Path segments are encoded,
query values use `URLSearchParams`, and all three fetch sites reject redirects.
A blocked redirect fails the request through the existing network-error path,
with empty quota metadata. Telemetry does not distinguish it from other network
failures.

Regression tests mock provider fetches and route dependencies. They exercise
invalid inputs before provider/cache/history access, valid fixture/live paths,
query-value isolation, and existing abort/quota telemetry. They assert the
`redirect: "error"` option at each fetch site; they do not simulate a redirect
or verify its failure path.
They make no provider calls and do not establish production-provider behavior.
The useful source PR #79 and its subsequent main analysis uploaded zero
findings, and all three alerts are now marked **fixed** by CodeQL on main.
Owner: `vneilly`; evidence remains on #59. No query suppression or manual alert
dismissal was used. For future findings, retain the alerts until the fix is
verified by uploaded analysis rather than manually declaring them fixed.

See the [CodeQL request-forgery guidance](https://codeql.github.com/codeql-query-help/javascript/js-request-forgery/)
for fixed-host and pathname restrictions. Broader provider-route abuse controls
remain tracked separately in #61; safe URL construction does not cap quota use.

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
