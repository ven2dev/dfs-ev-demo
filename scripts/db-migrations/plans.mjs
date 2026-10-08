import { canonicalJson, collectCatalog, fingerprint } from "../db-catalog.mjs";
import { compareCatalogs } from "../compare-db-catalog.mjs";
import { assertTransactionalSql, buildManifest, RUNNER_VERSION } from "./files.mjs";
import { contractSources, createCatalogVerifier, validateCatalogContract } from "./contracts.mjs";
import { checkConnectedTarget, configureTransaction, insertLedgerRow, ledgerSql, readLedger, withMigrationTransaction } from "./core.mjs";
import { refuse } from "./errors.mjs";
const preparedContexts = new WeakSet();

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Freeze exact validated bytes/contracts before any connection or transaction.
// The CLI additionally checks the committed manifest and schema reference.
export async function prepareMigrationContext(files, contracts) {
  ({ files, contracts } = structuredClone({ files, contracts }));
  if (!files.length || contracts.migrations.length !== files.length) refuse("migration-context-mismatch");
  for (const [index, file] of files.entries()) {
    if (file.version !== index + 1 || !/^[0-9]{4}_[a-z][a-z0-9_]*\.sql$/.test(file.filename) ||
        Number(file.filename.slice(0, 4)) !== file.version || file.sha256 !== fingerprint(file.sql)) refuse("migration-context-mismatch");
    assertTransactionalSql(file.sql);
  }
  const sources = await contractSources(files);
  validateCatalogContract(contracts.ledger, sources.ledger);
  for (const [index, contract] of contracts.migrations.entries()) validateCatalogContract(contract, sources.migrations[index]);
  const context = freeze({ files, contracts });
  preparedContexts.add(context);
  return context;
}

export function planFingerprint(plan) {
  const { planFingerprint: ignored, ...facts } = plan;
  void ignored;
  return fingerprint(canonicalJson(facts));
}

function targetIdentity(expected, environment) {
  if (!["test", "preview", "production"].includes(environment) || !expected.host ||
      !expected.database || !expected.user || !Number.isInteger(expected.port)) refuse("explicit-plan-target-required");
  return {
    declaredEnvironment: environment, hostFingerprint: fingerprint(expected.host).slice(0, 12),
    databaseFingerprint: fingerprint(expected.database).slice(0, 12), roleFingerprint: fingerprint(expected.user).slice(0, 12),
    port: expected.port,
    // Bind full identity, not just the displayed shortened hashes. Credentials
    // are excluded so routine password rotation does not change a schema plan.
    identityFingerprint: fingerprint(canonicalJson({ environment, host: expected.host,
      port: expected.port, database: expected.database, user: expected.user })),
  };
}

// Transactionless planner, shared by read-only plan and locked up recomputation.
// Only the observed catalog/history and validated source determine operations.
export async function computeMigrationPlan(client, { expected, environment, context }) {
  if (!preparedContexts.has(context)) refuse("prepared-migration-context-required");
  const target = targetIdentity(expected, environment);
  const { files, contracts } = context;
  const history = await readLedger(client, files); // Existing corrupt/empty ledgers never become "absent".
  const catalog = await collectCatalog(client, expected);
  let schemaVersion = null;
  let refusalCode = null;
  let verification = [];
  if (history !== null) {
    const version = history.at(-1).version;
    const expectedCatalog = { ...contracts.migrations[version - 1],
      objects: [...contracts.migrations[version - 1].objects, ...contracts.ledger.objects] };
    verification = [{ version, differences: compareCatalogs(expectedCatalog, catalog) }];
    if (verification[0].differences.length) refusalCode = "recorded-catalog-mismatch";
    else schemaVersion = version;
  } else if (!catalog.objects.length) {
    schemaVersion = 0;
  } else {
    verification = contracts.migrations.map((contract, index) => ({ version: index + 1,
      differences: compareCatalogs(contract, catalog) }));
    const matches = verification.filter((report) => !report.differences.length);
    if (matches.length === 1) {
      schemaVersion = matches[0].version;
      verification = matches;
    } else refusalCode = matches.length ? "ambiguous-unversioned-schema" : "unrecognized-unversioned-schema";
  }
  const operations = [];
  if (!refusalCode) {
    for (const file of files) {
      if (history !== null && file.version <= schemaVersion) continue;
      const action = file.version <= schemaVersion ? "adopt" : "execute";
      operations.push({ version: file.version, filename: file.filename, sha256: file.sha256, action });
    }
  }
  const plan = {
    formatVersion: 1, runnerVersion: RUNNER_VERSION, target,
    source: { manifest: buildManifest(files), ledgerContract: {
      catalogFingerprint: contracts.ledger.catalogFingerprint, source: contracts.ledger.source },
    contracts: contracts.migrations.map((contract, index) => ({ version: index + 1,
      catalogFingerprint: contract.catalogFingerprint, source: contract.source })) },
    observed: { postgresMajor: catalog.postgresMajor, catalogFingerprint: catalog.catalogFingerprint,
      ledger: history === null ? "absent" : "valid", ledgerVersion: history?.at(-1).version ?? 0,
      schemaVersion, history: (history ?? []).map((row) => ({ ...row, applied_at: row.applied_at.toISOString() })) },
    targetVersion: files.length, executable: refusalCode === null, refusalCode, verification, operations,
  };
  return freeze({ ...plan, planFingerprint: planFingerprint(plan) });
}

export async function readMigrationPlan(client, options) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await configureTransaction(client);
    await checkConnectedTarget(client, options.expected);
    const plan = await computeMigrationPlan(client, options);
    await client.query("COMMIT");
    return plan;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Candidate mutations remain limited to registered scratch targets while the
// owner-run Production mismatch/transport/recovery prerequisites are pending.
export async function runApprovedScratchMigrations(client, options) {
  const { expected, context, approvedFingerprint, assertTarget } = options;
  if (typeof approvedFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(approvedFingerprint)) refuse("approved-plan-fingerprint-required");
  if (options.environment !== "test" || typeof assertTarget !== "function") refuse("scratch-plan-target-required");
  assertTarget(expected);
  return withMigrationTransaction(client, expected, async () => {
    const plan = await computeMigrationPlan(client, options);
    if (plan.planFingerprint !== approvedFingerprint) refuse("approved-plan-changed");
    if (!plan.executable) refuse("migration-plan-not-executable");
    if (plan.observed.ledger === "absent") await client.query(ledgerSql);
    for (const operation of plan.operations) {
      const file = context.files[operation.version - 1];
      if (operation.action === "execute") await client.query(file.sql);
      await insertLedgerRow(client, file, operation.action === "adopt" ? "adopted" : "executed");
    }
    await createCatalogVerifier(context.contracts)(client, context.files.length);
    const history = await readLedger(client, context.files);
    if (history?.length !== context.files.length) refuse("incomplete-migration-history");
    // Preserve the history the owner approved and the provenance of each new
    // operation; catalog equality alone cannot prove the ledger result.
    const prior = history.slice(0, plan.observed.history.length).map((row) => ({ ...row, applied_at: row.applied_at.toISOString() }));
    if (canonicalJson(prior) !== canonicalJson(plan.observed.history) ||
        plan.operations.some((operation) => history[operation.version - 1].provenance !==
          (operation.action === "adopt" ? "adopted" : "executed"))) refuse("migration-history-result-mismatch");
    return { schemaVersion: context.files.length, planFingerprint: plan.planFingerprint,
      adopted: plan.operations.filter((operation) => operation.action === "adopt").map((operation) => operation.version),
      executed: plan.operations.filter((operation) => operation.action === "execute").map((operation) => operation.version) };
  });
}
