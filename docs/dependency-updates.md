# Dependency update review

`vneilly` owns dependency review and is the assignee configured in
[dependabot.yml](../.github/dependabot.yml). Routine npm, GitHub Actions, and
Docker Compose updates run Mondays at 09:00 America/Los_Angeles, with at most
five open version
PRs per ecosystem. Security fixes have separate groups and do not wait for
that weekly schedule or count toward the version-PR limit. Human review and
the required repository checks precede every merge; updates are not auto-merged.

## Merge reconciliation

Use merge commits to reconcile branches and merge dependency PRs. Automatic
Dependabot rebasing is disabled for all three ecosystems. If an update branch
falls behind `main`, merge `main` into that branch, resolve conflicts, and rerun the
required checks. Use GitHub's **Create a merge commit** option for the final
merge; do not invoke `@dependabot rebase`, rebase locally, or force-push a
rewritten branch. The PR description's standard bot commands do not establish
the repository's reconciliation policy.

The configuration applies after it reaches the default branch. GitHub notes
that already-open PRs can continue automatic rebasing until 30 days after
creation, even after `rebase-strategy: disabled` is set. Watch those existing
branches during the transition; the setting does not make them immediately
exempt. See [Dependabot's rebase strategy](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#rebase-strategy).

## Group policy

Related version groups come before production/development minor-and-patch
fallbacks. Next.js and `eslint-config-next` must retain identical exact
versions. React includes React DOM and both corresponding `@types` packages.
Tailwind includes its PostCSS integration. Test tooling includes Vitest,
jsdom, Testing Library, the Vite plugins used by the test configurations, and
the development-only `pg`/`@types/pg` driver pair. Driver updates must pass the
real PostgreSQL suite using the exact production SQL factory.

Docker Compose updates maintain the PostgreSQL tag and digest in
`compose.test.yml`, the single definition used locally and in CI. Keep its
multi-platform digest pin and check both Apple Silicon and Linux AMD64 support.
PostgreSQL major updates are ignored: moving beyond major 18 requires a
deliberate ticket that confirms production's major and updates the harness
contract. Review image updates for PostgreSQL and Alpine compatibility and run
`npm run test:db:local` before approving them. Confirm the first real Compose
update job discovers the file and assigns its PR after this configuration merges.

Firebase client, Admin, and tooling have separate version groups. The client
group excludes `@firebase/rules-unit-testing`; that package belongs with
`firebase-tools` in tooling. Related groups may contain coordinated major
upgrades, which require explicit compatibility review. Other major upgrades
remain individual PRs. Grouping does not establish compatibility by itself.

`@types/node` major updates are ignored to keep the declarations aligned with
the supported Node 24 runtime. Node runtime upgrades are maintained manually:
Dependabot does not update `.nvmrc` or the deployed runtime contract. A runtime
upgrade ticket must review `.nvmrc`, `package.json` engines and Node types, CI,
and Vercel configuration together, then reconsider this ignore rule.

Security groups separate production and development dependencies, including
transitive lockfile findings. They can include updates that also need the
Firebase checklists below. Review the actual changed dependency paths.

Local schema validation is preparatory. GitHub's acceptance of
`dependabot.yml`, update-job results, and actual grouping/assignment can only
be recorded after the configuration is merged into the default branch.

## Every update

Use Node 24 and a clean `npm ci` to check the resulting lockfile. Dependabot
uses its own npm version, so optional WASM packages can appear in its diff.
Judge those changes by dependency integrity, successful clean installation,
and compatibility; record unexplained changes for review.

- Confirm package versions, release notes, group membership, and peer ranges.
- For Next.js updates, read the installed version's relevant guides in
  `node_modules/next/dist/docs/` and verify the exact Next/ESLint version match.
- Run the full CI contract: typecheck, lint, whitespace checks, tests, Firestore
  rules emulator, CI-gate regression, DB target guards and PostgreSQL suite,
  build, and production audit. Record the Node version and
  results in the PR.
- Review the full development audit separately. A clean production audit does
  not dispose of development/build-tool findings. Retained findings need an
  advisory/path, exposure assessment, mitigation, owner, follow-up reference,
  and explicit review date.
- Verify CodeQL result upload when the workflow is available, including the
  first actual Dependabot PR. Dependabot's restricted token makes a successful
  upload a distinct check from a workflow simply starting or finishing.

## Firebase client checklist

Dependabot does not append this checklist to its PR body. The assignee copies
the applicable checklist into the PR description or a review comment before
approval, including security PRs and any other group that changes this chain.
Use the first genuine Firebase PR to record that this process was followed.

- [ ] Inspect Firebase/Firestore's upstream gRPC requirement and the changed
  dependency chain. Re-evaluate the scoped `@grpc/grpc-js` override at `1.14.5`.
- [ ] Check current advisories for the pinned version. Remove the override only
  when the selected upstream release resolves to a patched version by itself;
  regenerate the lockfile and validate without the override.
- [ ] Run `npm audit --omit=dev` and `npm ls @grpc/grpc-js`; record all resolved
  versions and any invalid/missing entries.
- [ ] Run `npm test` and `npm run test:firestore-rules`, exercising the client
  Firestore SDK against the local emulator with the resulting gRPC version.
- [ ] Record clean Node 24 `npm ci` and full CI results.

## Firebase Admin checklist

- [ ] Inspect `jwks-rsa`'s upstream `jose` requirement and reassess the
  `jose@5.10.0` override against compatibility and current advisories. Remove or
  update it only with an explicit rationale and validation.
- [ ] Inspect the `gaxios`/`uuid` chain and its `uuid@^11.1.1` override when
  those packages change, including whether upstream can now resolve safely
  without it.
- [ ] Run `npm run test:firebase-admin-runtime` explicitly, plus `npm test`.
  The runtime check tests `firebase-admin/auth` without Node's experimental
  require-module behavior.
- [ ] Run `npm audit --omit=dev` and
  `npm ls firebase-admin jwks-rsa jose gaxios uuid @grpc/grpc-js`; review actual
  paths, versions, and invalid/missing entries.
- [ ] Record clean Node 24 `npm ci` and full CI results.

For Firebase tooling updates, also run the Firestore emulator compatibility
check and recheck previously deferred tooling advisories. Apply either SDK
checklist if the update changes that SDK's resolved dependency chain.

## Override maintenance

`package.json` overrides need manual review. Recheck them on relevant Firebase,
Admin, `jwks-rsa`, `gaxios`, or other owning-chain updates, on new advisories,
and during weekly security triage. Exact pins can become vulnerable even when
Dependabot opens no override update. Record the chosen patched version, scope,
compatibility evidence, and condition for eventual removal.

See the [gRPC override rationale](../README.md#firebase-client-grpc-override)
and [security policy](../SECURITY.md). Maintainer ownership, audit dispositions,
notification evidence, and automation recovery follow the
[security operations runbook](security-operations.md).
