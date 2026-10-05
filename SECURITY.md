# Security policy

## Report a vulnerability privately

Use this repository's [private vulnerability reporting form](https://github.com/ven2dev/dfs-ev-demo/security/advisories/new)
to submit a report. Include the affected deployment or commit, reproduction
steps, expected and observed
behavior, and potential impact. Use a minimal reproduction with sensitive
values removed. Keep credentials, account data, and vulnerability details in
the private report rather than a public issue, PR, or log.

Security reports are handled by `vneilly`. We aim to acknowledge reports within
five business days on a best-effort basis, subject to maintainer availability.
Assessment and remediation timing depend on impact and the available fix.
Coordinate disclosure in the private report while a fix is being assessed.

Fixes are developed against current `main` and the application deployed from
it. Include the affected version or deployment in your report; older branches
do not have a separate maintenance policy.

## Dependency review and overrides

Dependabot proposes weekly npm and GitHub Actions version updates and advisory
driven security fixes. Dependency PRs are assigned to `vneilly` and require
human review and repository checks before merging. See the
[dependency review guide](docs/dependency-updates.md) for grouping, installation
checks, and the Firebase client/Admin PR checklists.

Dependabot does not maintain the `package.json` overrides. Review their
upstream requirements, advisories, compatibility, and removal conditions on
relevant dependency bumps, new advisories, and during weekly security triage:

| Override | Recheck when |
| --- | --- |
| `@firebase/firestore` → `@grpc/grpc-js@1.14.5` | Firebase/Firestore or gRPC advisories change; a Firebase client PR must include production audit, resolved gRPC versions, tests, and `test:firestore-rules` evidence. |
| `jwks-rsa` → `jose@5.10.0` | Firebase Admin, jwks-rsa, or jose changes; an Admin PR must revalidate this override and run `test:firebase-admin-runtime`, tests, resolved-version checks, and production audit. |
| `gaxios` → `uuid@^11.1.1` | Firebase Admin or the gaxios/uuid dependency chain changes; verify runtime compatibility and whether the upstream chain can resolve safely without the override. |

Remove an override when the chosen upstream release resolves safely without
it, then regenerate the lockfile and validate the resulting installation and
runtime. An exact pin needs continuing review even if no update PR appears.
The client gRPC rationale and removal trigger are documented in the
[README](README.md#firebase-client-grpc-override).

Production and development findings receive separate assessments. Development
dependencies can still process untrusted build or CLI input. A retained
finding requires an owner, advisory and dependency path, exposure assessment,
mitigation, follow-up reference, and review date; a development-only label
does not resolve it.

## Credentials and automation

Keep application credentials in the configured environment or secrets store.
If a credential is exposed, the maintainer revokes or rotates it, checks for
misuse, and investigates the exposure. Deleting the text alone does not revoke
the credential.

Secret scanning and push protection cover supported patterns. Controlled
verification uses GitHub's documented dummy only in a temporary web-editor
attempt that is cancelled and discarded. Evidence describes the block without
including the string in issue/PR content, screenshots, or logs.

CodeQL security analysis uses no production application secrets and makes no
paid provider calls. The separate Collector Health operational workflow uses
its existing health endpoint credentials. Maintainers track automation state,
notification evidence, and verification in the
[security operations runbook](docs/security-operations.md).
