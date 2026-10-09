// Reviewed required cases are static: deleting a test must not delete its gate.
export const LEASE_REQUIRED_CASES = Object.freeze([
  "bootstraps the full application schema twice on PostgreSQL 18",
  ...["cold", "stale"].flatMap((state) => [
    `25 independent clients acquire exactly one ${state}-row lease`,
    `observes all 24 contenders blocked behind a held ${state}-row acquisition transaction`,
  ]),
  "renewing an expired lease extends it and prevents competing takeover",
  "25 independent clients produce exactly one takeover of a forced expired lease",
  "characterization: an expired owner may renew before any takeover",
  "characterization: an expired owner may publish before any takeover",
  "a replaced owner cannot renew, write, or release the new owner's lease",
  "an expired owner's write committed first makes all blocked takeovers fail",
  "a takeover committed first makes the blocked former-owner write lose its lease",
  "25 database-backed consumers wait for one fetch and receive the same persisted payload",
]);

export const READINESS_REQUIRED_CASES = Object.freeze([
  "database readiness reports missing ledger without creating one on authentic current schema",
  "database readiness accepts migrated history and valid ahead history while preserving rows",
  "database readiness refuses behind, corrupt and missing-table states without repair",
  "database readiness reads are bounded, enforced read-only and reject view substitutes",
]);

export const PREDICTIVE_REQUIRED_CASES = Object.freeze([
  "predictive PostgreSQL A/B replay preserves the earlier bundle and uses later corrections",
  "predictive scoped reads retain corrections that move evidence out of the indexed scope",
  "predictive persistence retains former-team membership gaps and ignores unrelated schedule dependencies",
  "predictive retries and unchanged recaptures preserve immutable revisions and their earliest provenance",
  "predictive publication is invisible until commit and concurrent retries publish one batch",
  "predictive failed and partial publication quarantine diagnostics without exposing partial inputs",
  "predictive publication rolls back conflicts and invalid correction lineage while retaining the earlier replay",
  "predictive immutable rows, typed evidence and correction keys are enforced by PostgreSQL",
  "predictive missing or tampered artifact bytes withhold replay without replacing stored evidence",
  "predictive indexed membership reads are player-scoped and read transactions remain read-only",
  "predictive archive restoration recreates the same cutoff bundles in fresh scratch databases",
  "predictive v2 upgrade preserves application rows and no-op migrations preserve the new history",
]);

export const NODE_REQUIRED_CASES = Object.freeze({
  "tests/db/target.check.mjs": Object.freeze([
    "accepts only explicit loopback test connections",
    "rejects missing, external, production, ambiguous, and overridden targets without exposing the URL",
    "rejects application credentials and ambient pg configuration",
  ]),
  "tests/db/bootstrap-unit.check.mjs": Object.freeze([
    "primary migration bootstrap refuses unsafe targets and remote credentials before database access",
  ]),
  "tests/db/report-unit.check.mjs": Object.freeze([
    "Node DB report requires each named case in its original file and a complete successful summary",
    "actual Node reports refuse zero, filtered, missing, skipped, todo and failed cases",
    "Vitest DB report preserves all required lease cases and refuses missing, skipped, todo or failed results",
    "Vitest DB report requires the readiness cases independently of the existing 13 lease cases",
    "Vitest DB report requires every predictive persistence case independently of lease and readiness cases",
  ]),
  "tests/db/readiness-manifest-unit.check.mjs": Object.freeze([
    "readiness generation binds the explicit minimum to validated migration and table contracts",
    "readiness artifact checks reject missing or stale runtime manifests without rewriting them",
  ]),
  "tests/db/catalog-unit.check.mjs": Object.freeze([
    "catalog requires explicit credentials, environment and matching expected target",
    "catalog rejects pooled, non-Neon and URL overrides without reflecting credentials",
    "catalog test mode retains the existing strict disposable guard",
    "catalog fingerprint canonicalizes object keys without discarding semantic differences",
    "snapshot destinations must be outside the repo, including symlinked parents",
    "CLI refuses malformed configuration without printing parser errors or URL values",
    "catalog comparison reports every missing, unexpected and changed definition",
  ]),
  "tests/db/contracts-unit.check.mjs": Object.freeze([
    "contracts bind every immutable prefix, ledger DDL and inventory query and omit environment metadata",
    "contract drift check reports all changed, missing and unexpected artifacts without writing",
    "contract CLI refuses missing or remote targets and unsupported options without connecting or leaking values",
    "regeneration refuses catalog classes that lack complete definition coverage",
  ]),
  "tests/db/migrations-unit.check.mjs": Object.freeze([
    "candidate artifacts preserve the authentic historical boundary and all schema comments",
    "manifest rejects edited bytes, missing files, extra fields and unsupported runner versions",
    "migration files refuse gaps, down files, CRLF, empty content and symlinked SQL",
    "SQL cannot end the runner transaction even behind comments and quoted statements",
    "ledger validation refuses holes, checksum mismatches, empty history and unknown provenance",
    "manual status requires explicit matching targets and up requires approval before any connection",
    "manifest generation never rewrites known migration checksums",
  ]),
  "tests/db/plans-unit.check.mjs": Object.freeze([
    "planning context freezes validated source and refuses edited bytes, contracts and forged contexts",
    "fingerprints bind facts while remaining independent of object key order and their own stored value",
    "plan requires private output, explicit matching target and read-only command options",
    "up cannot bypass fingerprint approval, scratch registration or pending owner evidence",
  ]),
  "tests/db/catalog.integration.check.mjs": Object.freeze([
    "empty export creates neither application objects nor migration ledger",
    "exports authentic eight-table pre-41 and seventeen-table current candidates",
    "exports preserve synthetic rows and exclude row values and sequence progress",
    "database enforces read-only export and failed exports roll back their session",
    "catalog refuses an unexpected connected database before catalog access",
    "collector refuses noncanonical and shadow search paths before inventory without changing transaction boundaries",
    "extension inventory covers members by exact dependency ownership and retains unrelated objects",
  ]),
  "tests/db/contracts.integration.check.mjs": Object.freeze([
    "both generated contracts match independent historical fixtures without a ledger",
    "full verifier reports every real column, key, check, FK, index, sequence and unexpected-object mismatch without repair",
    "unenforced foreign keys and disabled internal enforcement triggers are detected independently of validation",
    "a naturally failed concurrent unique-index build exposes invalidity to the verifier",
    "failed upgrade verification preserves the committed baseline, seeded rows and original ledger",
    "extra ledger objects and removed ledger constraints fail even when ledger rows remain valid",
    "fresh scratch databases reproduce contracts while ignoring owner roles, OIDs and sequence progress",
    "contract generation refuses unsupported managed objects and cleans up its scratch databases",
    "an extension can be explicitly contracted without its members hiding application drift",
  ]),
  "tests/db/migrations.integration.check.mjs": Object.freeze([
    "empty installation matches the authentic current catalog and reruns preserve ledger and relational rows",
    "read-only status creates no ledger and unversioned application schemas cannot be adopted",
    "recorded baseline upgrades preserve seeded relationships and working sequence defaults",
    "PostgreSQL rejects writes inside status and failed status restores the session",
    "second migration invalid SQL rolls back the successful first file and its ledger insert",
    "deep catalog mismatch rolls back all application DDL and ledger writes without an inner commit",
    "held transaction lock fails promptly and concurrent runners cannot double-apply",
    "empty, partial, hole, checksum and unknown-runner ledgers fail without repair",
    "scratch target guards refuse primary, external, overridden and released database names",
  ]),
  "tests/db/plans.integration.check.mjs": Object.freeze([
    "read-only plans are deterministic, create no ledger and fresh approvals install then no-op",
    "verified seeded current adoption changes only ledger metadata and never replays application SQL",
    "verified seeded pre-41 adoption records its baseline and executes additions while preserving rows and sequences",
    "approved recorded-baseline upgrades preserve existing ledger rows and execute only the pending file",
    "ambiguous unversioned catalogs never guess the latest version or adopt",
    "partial or mismatched unversioned schemas expose every candidate difference and refuse approved adoption without repair",
    "schema, history, source checksums and target changes invalidate approval before any mutation",
    "invalid SQL after verified baseline adoption rolls back ledger creation and preserves the authentic schema",
    "failed final verification rolls back adoption and upgrade with nothing leaked to a second connection",
    "pre-existing empty, partial, hole, checksum and unknown-runner ledgers are refused rather than adopted",
    "valid ledger rows with catalog drift produce a readable non-executable plan",
    "incomplete or rewritten ledger results cannot commit after otherwise valid migration SQL",
    "plan is enforced read-only and restores the session after a PostgreSQL write refusal",
    "up takes the lock before reading history and concurrent adoption cannot double-apply",
    "missing approval and unregistered, primary or remote mutation targets fail before a transaction",
    "owner plan CLI writes a private exclusive artifact outside Git without changing the shared database",
  ]),
});

const refuse = () => { throw new Error("DB test contract failed: required cases must execute and pass; skipped/todo or missing cases are failures."); };

export function validateNodeDbReport(report, required = NODE_REQUIRED_CASES) {
  const count = Object.values(required).reduce((sum, names) => sum + names.length, 0);
  const counts = report?.summary?.counts;
  if (!count || report?.formatVersion !== 1 || report?.summary?.success !== true ||
      !Number.isInteger(counts?.tests) || counts.tests < count || counts.passed !== counts.tests ||
      ["failed", "cancelled", "skipped", "todo"].some((key) => counts[key] !== 0) ||
      !Array.isArray(report.assertions) || report.assertions.some((row) => row.status !== "passed")) refuse();
  for (const [file, names] of Object.entries(required)) {
    for (const name of names) {
      const matches = report.assertions.filter((row) => row.file === file && row.name === name && row.nesting === 0);
      if (matches.length !== 1) refuse();
    }
  }
  return count;
}

export function validateLeaseDbReport(report, required = LEASE_REQUIRED_CASES) {
  const assertions = report?.testResults?.flatMap((file) => file.assertionResults);
  if (!required.length || report?.success !== true || !Array.isArray(assertions) ||
      !Number.isInteger(report.numPassedTests) || report.numPassedTests < required.length ||
      report.numPassedTests !== assertions.length || assertions.some((test) => test.status !== "passed")) refuse();
  for (const name of required) if (assertions.filter((test) => test.fullName === name).length !== 1) refuse();
  return required.length;
}

export const validateReadinessDbReport = (report) => validateLeaseDbReport(report, READINESS_REQUIRED_CASES);
export const validatePredictiveDbReport = (report) => validateLeaseDbReport(report, PREDICTIVE_REQUIRED_CASES);
