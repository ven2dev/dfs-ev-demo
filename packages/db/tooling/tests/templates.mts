import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rm, lstat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "pg";
import { checkConnectedTarget, runScratchMigrations } from "../scripts/db-migrations/core.mjs";
import { checkMigrationArtifacts } from "../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../scripts/db-migrations/contracts.mjs";
import { prepareMigrationContext } from "../scripts/db-migrations/plans.mjs";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "./target.mts";

type Environment = NodeJS.ProcessEnv;
type Base = ReturnType<typeof parseTestDatabaseUrl>;
type Identity = Pick<Base, "host" | "port" | "database" | "user">;
export type TemplateReference = Readonly<{ database: string; version: number }>;
type Manifest = Readonly<{
  formatVersion: 1; runId: string; sourceDigest: string; target: Identity;
  templates: readonly TemplateReference[];
}>;
type Proposal = { name: string; bytes: Buffer };
type Registry = { manifest: Manifest; directory: string; base: Base };
const references = new WeakMap<TemplateReference, Registry>();
const registries = new Map<string, Promise<Registry>>();
function refuse(): never { throw new Error("Unregistered, stale or unsafe DB test template refused."); }
const identity = ({ host, port, database, user }: Base): Identity => ({ host, port, database, user });
const sameKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(",") === keys.sort().join(",");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const ownedName = (name: unknown, runId: string): name is string =>
  typeof name === "string" && new RegExp(`^dfs_ev_test_${runId}[a-f0-9]{8}$`).test(name);
const comment = (manifest: Manifest, version: number) =>
  `dfs-ev-template:${manifest.runId}:${version}:${manifest.sourceDigest}`;

let artifacts: ReturnType<typeof loadArtifacts> | undefined;
async function loadArtifacts(proposals: readonly Proposal[] = []) {
  const files = await checkMigrationArtifacts();
  const context = await prepareMigrationContext(files, await loadCatalogContracts(files));
  const sourceDigest = createHash("sha256").update(JSON.stringify({
    files: files.map(({ version, filename, sha256 }) => ({ version, filename, sha256 })),
    contracts: [context.contracts.ledger, ...context.contracts.migrations].map(({ catalogFingerprint }) => catalogFingerprint),
    ...(proposals.length && { proposals: proposals.map(({ name, bytes }) =>
      ({ name, sha256: createHash("sha256").update(bytes).digest("hex") })) }),
  })).digest("hex");
  return { files: context.files as Array<{ version: number; filename: string; sha256: string; sql: string }>, contracts: context.contracts, sourceDigest };
}
const inputs = (proposals: readonly Proposal[] = []) =>
  proposals.length ? loadArtifacts(proposals) : artifacts ??= loadArtifacts();

const readProposals = (paths: readonly URL[]) => Promise.all(paths.map(async path =>
  ({ name: basename(path.pathname), bytes: await readFile(path) })));

async function applyProposals(client: Client, proposals: readonly Proposal[]) {
  await client.query("BEGIN");
  try {
    for (const proposal of proposals) await client.query(proposal.bytes.toString("utf8"));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export const applyScratchProposals = async (client: Client, paths: readonly URL[]) =>
  applyProposals(client, await readProposals(paths));

// Pure validation happens before a manifest can grant access to any database.
export function validateTemplateManifest(value: unknown, base: Base, sourceDigest: string, versionCount: number): Manifest {
  if (!object(value) || !sameKeys(value, ["formatVersion", "runId", "sourceDigest", "target", "templates"]) ||
      value.formatVersion !== 1 || typeof value.runId !== "string" || !/^[a-f0-9]{12}$/.test(value.runId) ||
      value.sourceDigest !== sourceDigest || !object(value.target) ||
      !sameKeys(value.target, ["host", "port", "database", "user"]) ||
      JSON.stringify(identity(base)) !== JSON.stringify({ host: value.target.host, port: value.target.port,
        database: value.target.database, user: value.target.user }) ||
      !Array.isArray(value.templates) || value.templates.length !== versionCount) refuse();
  const runId = value.runId;
  const templates = value.templates.map((entry: unknown, index: number) => {
    if (!object(entry) || !sameKeys(entry, ["database", "version"]) || entry.version !== index + 1 ||
        !ownedName(entry.database, runId)) refuse();
    return Object.freeze({ database: entry.database, version: index + 1 });
  });
  if (new Set(templates.map(({ database }) => database)).size !== templates.length) refuse();
  return Object.freeze({ formatVersion: 1, runId, sourceDigest, target: Object.freeze(identity(base)),
    templates: Object.freeze(templates) });
}

async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) refuse();
}
async function readPrivateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) refuse();
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

export async function getTemplateReference(environment: Environment, version?: number, proposalPaths: readonly URL[] = []): Promise<TemplateReference> {
  assertNoApplicationCredentials(environment);
  const base = parseTestDatabaseUrl(environment.TEST_DATABASE_URL, environment.DB_TEST_LANE ?? "default");
  if (!environment.TEST_DATABASE_TEMPLATE_MANIFEST) throw new Error("DB template manifest required; run npm run test:db:local or test:db.");
  const path = resolve(environment.TEST_DATABASE_TEMPLATE_MANIFEST);
  let registry = proposalPaths.length ? undefined : registries.get(path);
  if (!registry) {
    registry = (async () => {
      const directory = dirname(path);
      await privateDirectory(directory);
      await privateDirectory(join(directory, "clones"));
      const { sourceDigest, files } = await inputs(await readProposals(proposalPaths));
      const count = proposalPaths.length ? 1 : files.length;
      const manifest = validateTemplateManifest(await readPrivateJson(path), base, sourceDigest, count);
      return { manifest, directory, base };
    })();
    if (!proposalPaths.length) registries.set(path, registry);
  }
  const context = await registry;
  if (JSON.stringify(identity(base)) !== JSON.stringify(context.manifest.target)) refuse();
  const selected = version ?? context.manifest.templates.length;
  if (!Number.isInteger(selected) || selected < 1 || selected > context.manifest.templates.length) refuse();
  const reference = context.manifest.templates[selected - 1];
  references.set(reference, context);
  return reference;
}

// Register before CREATE: the parent can clean an interrupted worker's clone,
// including a CREATE whose response was lost. A private run prefix prevents a
// malformed registry entry from authorizing a drop of an unrelated database.
export async function registerTemplateClone(admin: Client, reference: TemplateReference) {
  const registry = references.get(reference);
  if (!registry) refuse();
  const { manifest, directory, base } = registry;
  await privateDirectory(directory);
  await privateDirectory(join(directory, "clones"));
  const { rows } = await admin.query<{ owner: string; datallowconn: boolean; marker: string }>(
    `SELECT pg_get_userbyid(datdba) AS owner, datallowconn, shobj_description(oid,'pg_database') AS marker
     FROM pg_database WHERE datname=$1`, [reference.database]);
  if (rows.length !== 1 || rows[0].owner !== base.user || rows[0].datallowconn !== false ||
      rows[0].marker !== comment(manifest, reference.version)) refuse();
  let database: string;
  do { database = `dfs_ev_test_${manifest.runId}${randomBytes(4).toString("hex")}`; }
  while (manifest.templates.some((template) => template.database === database));
  const path = join(directory, "clones", database + ".json");
  await writeFile(path, JSON.stringify({ runId: manifest.runId, database }), { mode: 0o600, flag: "wx" });
  return { database, source: reference.database, release: () => rm(path, { force: true }) };
}

export async function createTemplateRun(environment: Environment, directory: string, signal?: AbortSignal, proposalPaths: readonly URL[] = []) {
  assertNoApplicationCredentials(environment);
  const base = Object.freeze(parseTestDatabaseUrl(environment.TEST_DATABASE_URL, environment.DB_TEST_LANE ?? "default"));
  signal?.throwIfAborted();
  await privateDirectory(directory);
  if ((await readdir(directory)).length) throw new Error("DB template run requires an empty private directory.");
  const proposals = await readProposals(proposalPaths);
  const { files, contracts, sourceDigest } = await inputs(proposals);
  const templateCount = proposals.length ? 1 : files.length;
  const cloneDirectory = join(directory, "clones");
  await mkdir(cloneDirectory, { mode: 0o700 });
  const manifestPath = join(directory, "templates.json");
  const runId = randomBytes(6).toString("hex");
  const owned = new Set<string>();
  const makeName = () => `dfs_ev_test_${runId}${randomBytes(4).toString("hex")}`;
  const failure = new AbortController();
  const newAdmin = () => {
    const client = new Client(base);
    client.on("error", (cause: Error) => {
      if (!failure.signal.aborted) failure.abort(new Error("DB template admin connection lost.", { cause }));
    });
    return client;
  };
  const admin = newAdmin();
  const checkCancellation = () => { signal?.throwIfAborted(); failure.signal.throwIfAborted(); };
  let connected = false;
  let closed = false;
  const migrationVersions: number[] = [];
  const templates: TemplateReference[] = [];
  const markerManifest: Manifest = { formatVersion: 1, runId, sourceDigest, target: identity(base), templates };
  const assertOwned = (config: Base) => {
    if (!owned.has(config.database) || !ownedName(config.database, runId) ||
        JSON.stringify({ ...config, database: base.database }) !== JSON.stringify(base)) refuse();
  };
  async function drop(database: string) {
    if (!ownedName(database, runId)) refuse();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  }
  async function close() {
    if (closed) return;
    closed = true;
    registries.delete(resolve(manifestPath));
    const errors: unknown[] = [];
    try {
      try { await rm(manifestPath, { force: true }); } catch (error) { errors.push(error); }
      if (connected) {
        let entries: string[] = [];
        try { await privateDirectory(cloneDirectory); entries = await readdir(cloneDirectory); } catch (error) { errors.push(error); }
        for (const entry of entries) {
          try {
            const value = await readPrivateJson(join(cloneDirectory, entry));
            if (!object(value) || !sameKeys(value, ["runId", "database"]) || value.runId !== runId ||
                !ownedName(value.database, runId) || entry !== value.database + ".json") refuse();
            await drop(value.database);
            await rm(join(cloneDirectory, entry));
          } catch (error) { errors.push(error); }
        }
        for (const database of [...owned].reverse()) {
          try { await drop(database); owned.delete(database); } catch (error) { errors.push(error); }
        }
      }
    } finally { try { await admin.end(); } catch (error) { errors.push(error); } }
    if (failure.signal.aborted) errors.unshift(failure.signal.reason);
    if (errors.length) throw new AggregateError(errors, "DB template cleanup failed.");
  }
  try {
    checkCancellation();
    await admin.connect();
    connected = true;
    await checkConnectedTarget(admin, base);
    const builder = proposals.length ? `dfs_ev_test_${runId}${sourceDigest.slice(0, 8)}` : makeName();
    owned.add(builder);
    await admin.query(`CREATE DATABASE "${builder}"`);
    // Associate an in-progress builder with its private run directory, before
    // the ready manifest exists, for cancellation diagnostics and cleanup proofs.
    const directoryDigest = createHash("sha256").update(resolve(directory)).digest("hex");
    await admin.query(`COMMENT ON DATABASE "${builder}" IS 'dfs-ev-template-builder:${runId}:${directoryDigest}'`);
    const expected = Object.freeze({ ...base, database: builder });
    const prefixes = proposals.length ? [files.length] : files.map(file => file.version);
    for (const lastVersion of prefixes) {
      checkCancellation();
      const client = new Client(expected);
      try {
        await client.connect();
        await checkConnectedTarget(client, expected);
        if (!proposals.length && lastVersion === 1) {
          // Keep TS role-module loading out of the raw scratch/CLI path: those
          // commands intentionally have exact stderr contracts.
          const { ensureLegacyPredictiveRoles } = await import("./legacyRoles.ts");
          const { ensureCorpusImporterRole } = await import("./corpusRoles.ts");
          await ensureLegacyPredictiveRoles(client);
          await ensureCorpusImporterRole(client);
        }
        const { executed }: { executed: number[] } = await runScratchMigrations(client, { expected, files: files.slice(0, lastVersion),
          assertTarget: assertOwned, verify: createCatalogVerifier(contracts) });
        const expectedVersions = files.slice(migrationVersions.length, lastVersion).map(file => file.version);
        if (executed.length !== expectedVersions.length ||
            executed.some((version, index) => version !== expectedVersions[index])) {
          throw new Error("DB template migration work budget exceeded.");
        }
        migrationVersions.push(...executed);
        if (proposals.length) await applyProposals(client, proposals);
      } finally { await client.end(); }
      checkCancellation();
      // PostgreSQL copies a quiescent verified prefix. Sealing each snapshot
      // prevents a worker connection from mutating the shared fixture source.
      // The final proposal fixture has no migration prefixes. Seal its builder
      // directly so the run retains just one source database.
      const database = proposals.length ? builder : makeName();
      if (!proposals.length) {
        owned.add(database);
        await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${builder}"`);
      }
      // In a proposal manifest, version 1 identifies the single proposal template.
      const version = templates.length + 1;
      await admin.query(`COMMENT ON DATABASE "${database}" IS '${comment(markerManifest, version)}'`);
      await admin.query(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`);
      templates.push(Object.freeze({ database, version }));
    }
    if (!proposals.length) {
      await drop(builder);
      owned.delete(builder);
    }
    const manifest = validateTemplateManifest(markerManifest, base, sourceDigest, templateCount);
    checkCancellation();
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    const stats = Object.freeze({ migrationVersions: Object.freeze([...migrationVersions]),
      templateCount: templates.length, catalogVerifications: templates.length,
      ...(proposals.length ? { sourceDigest, proposalCount: proposals.length } : {}) });
    return { manifestPath, stats, failureSignal: failure.signal, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "DB template build and cleanup failed."); }
    throw error;
  }
}
