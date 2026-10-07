# #60 Production read-only evidence handoff

Reviewed on 2026-10-07 against local commit `ceb7e90` on
`feature/dfsEV-60-versioned-db-migrations`. The owner supplied a Production
catalog snapshot and read-only migration plan and reported successful Neon
read-only transport checks. The owner explicitly instructed: **Do not run `up`
yet.** No remote command, adoption or database mutation was performed during
this review.

## Private artifacts

Both artifacts remain in the owner's private `~/.config/dfs-ev-demo/db-snapshots/`
directory outside the repository, with mode `0600`. Only sanitized results and
digests are recorded here; the artifacts were not copied into Git.

| Artifact | SHA-256 of file bytes |
| --- | --- |
| `production-before-60.json` | `ddd7794a00c77bd0a0633aabc69bcf24bfc80cfec45a75c92f621929d2750012` |
| `production-plan-60.json` | `d0efb1c3366677613b83718c5ec3510a6ba6716e2cf523ebea8fa1a52b86b427` |

The snapshot was captured at `2026-10-07T05:46:23.019Z`, which is
2026-10-06 at 22:46:23 in America/Los_Angeles. The plan does not embed a capture
timestamp or source commit. The review binds its source to the local checkout;
it does not infer which commit the owner used for the commands.

## Verified artifact results

Offline review used the repository's snapshot validation, complete catalog
comparison, migration artifact/contract validation and fingerprint functions.
It verified:

- PostgreSQL major 18 and 17 application tables in the managed `public` catalog.
- No `db_migrations` relation, an absent ledger, ledger version 0 and empty
  recorded history. Version 0 describes recorded history; the existing schema
  matches version 2.
- Exactly one matching migration-prefix catalog: version 2, with zero
  differences across all inventoried definitions. All nine #41 tables are
  included in this complete match. No reconciliation is required for this
  captured managed catalog.
- Matching snapshot/plan target hashes and observed catalog fingerprints.
- Valid recomputed snapshot and plan fingerprints, with the plan's migration
  manifest, catalog-query bindings and ledger/prefix contracts matching the
  current immutable source artifacts.
- `executable: true`, no refusal code, target version 2 and exactly two
  operations: adopt version 1 and adopt version 2. The proposed transaction
  would create the ledger and record both existing migrations as `adopted`,
  without replaying their application SQL.

The catalog fingerprint is
`be99ea6e1473dcc6b47dbb2aa23a57487a5c8529adabe725dfc19c0d731185e3`.
The plan fingerprint is
`bd1c25a2074af6398b369092936f2f439543a9215c3414ecc6737a8b80579d84`.
These fingerprints identify the supplied evidence; neither is recorded as an
approved execution fingerprint.

## Owner-reported transport result

The owner reports that the Production snapshot/status/plan handoff and Neon
read-only transport checks passed. Status reported version 0 without creating a
ledger. This owner-run result is accepted as the transport outcome; the offline
review made no Production connection.

The roadmap also calls for the command commit, Node/driver versions, exit codes
and sanitized status to be recorded on #60. The supplied artifacts do not carry
that runtime metadata, so the detailed command record remains outstanding.
The current checkout's dependency version is not evidence of the owner's
runtime version.

## Step 5 local verification

On 2026-10-07, the working tree based on `ceb7e90` added protected
`GET /api/health/database`, the generated runtime manifest and mandatory
readiness proofs. The owner approved committing these changes after local
validation. No Production command was run.

Typecheck, lint, 458 application tests, the three CI-gate tests, Firestore rules
checks and the production build passed. The full disposable pipeline passed
once and then in three consecutive isolation runs: each required 73 named Node
cases, all 13 #45 cases and four readiness cases, plus artifact/contract drift
checks. Scratch databases and the Compose service/network were removed. The
production readiness dependency trace excludes migration tooling, SQL artifacts
and the development `pg` client.

The production audit exited successfully at the repository's critical-severity
threshold, while reporting two high-severity findings in existing dependencies:
[sharp](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) and
[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
No dependency versions changed in this readiness work. These findings remain
open for the dependency/security update workflow; an audit threshold pass is
not a zero-vulnerability result.

Neon HTTP readiness behavior is covered through the repository/route tests;
actual read SQL is exercised with local `pg`. Owner-run deployed HTTP readiness
evidence remains pending after approved adoption and deployment.

## Remaining release prerequisites

The [migration guide](database-migrations.md) and
[approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/60#issuecomment-6006046013)
still require:

1. Usable recovery evidence: an owner-run logical backup and successful restore
   into a separate private recovery target using compatible PostgreSQL 18
   tools. An archive listing alone does not prove recovery. Production data
   stays outside the relay worktree, Git, CI and disposable test databases.
2. A disposition for provider recovery access and limitations under
   [#86](https://github.com/ven2dev/dfs-ev-demo/issues/86). Branch/PITR access and
   retention remain unverified; successful SQL connectivity does not prove
   those capabilities. Retain the logical recovery fallback.
3. Step 5's protected database readiness check is implemented and verified
   locally; deployed readiness evidence remains pending. Step 6's complete
   release/recovery documentation still needs the forward-fix and application
   rollback compatibility rules.
4. Separate review of remote activation and explicit owner approval of a fresh
   plan before adoption. The current CLI continues to refuse remote `up` with
   `owner-rollout-evidence-pending`.
5. Schema adoption and verification before the owner-approved merge/deploy,
   followed by protected readiness and application/collector smoke checks.

The read-only handoff is complete. Production activation, adoption, recovery
verification, merge and deployment are not completed or authorized by it.
