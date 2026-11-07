import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { certifyRawScrubRange } from "../../src/featureStore/integrityScrub.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";

const localTarget = (value: string | undefined): URL => {
  if (!value) throw new Error("FS170_DATABASE_URL is required");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("integrity-scrub-database-refused"); }
  if (!["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.username || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash) {
    throw new Error("integrity-scrub-database-refused");
  }
  return url;
};

const run = async () => {
  const { values } = parseArgs({ options: {
    root: { type: "string" }, receipt: { type: "string" }, "start-after": { type: "string" },
    "inventory-limit": { type: "string" }, "snapshot-limit": { type: "string" }, "wire-byte-limit": { type: "string" },
  } });
  if (!values.root || !isAbsolute(values.root) || !values.receipt || !isAbsolute(values.receipt)) {
    throw new Error("absolute --root and --receipt paths are required");
  }
  const target = localTarget(process.env.FS170_DATABASE_URL);
  if (process.env.DATABASE_URL) {
    const app = new URL(process.env.DATABASE_URL);
    if ((app.port || "5432") === (target.port || "5432") && decodeURIComponent(app.pathname) === target.pathname) {
      throw new Error("integrity-scrub-app-database-refused");
    }
  }
  const files = [
    import.meta.url, import.meta.resolve("../../src/featureStore/integrityScrub.ts"),
    import.meta.resolve("../../src/featureStore/localObjectStore.ts"), import.meta.resolve("../../src/featureStore/objectStore.ts"),
  ];
  const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });
  const repo = git(scriptDirectory, "rev-parse", "--show-toplevel").toString().trim();
  const gitSha = git(repo, "rev-parse", "HEAD").toString().trim();
  const paths = files.map((file) => relative(repo, fileURLToPath(file)));
  if (git(repo, "status", "--porcelain", "--untracked-files=all", "--", ...paths).length) {
    throw new Error("integrity-scrub-dirty-code");
  }
  const hashes = await Promise.all(files.map(async (file, index) => {
    const bytes = await readFile(new URL(file));
    if (!bytes.equals(git(repo, "show", `${gitSha}:${paths[index]}`))) {
      throw new Error("integrity-scrub-dirty-code");
    }
    return sha256(bytes);
  }));
  const code = { gitSha, contentSha256: sha256(Buffer.from(JSON.stringify(hashes))) };
  const store = await openLocalObjectStore(values.root, { maxObjectBytes: 64 * 1024 * 1024 });
  const db = new Client({ connectionString: target.href, connectionTimeoutMillis: 3_000,
    statement_timeout: 15_000, options: "-c default_transaction_read_only=on" });
  await db.connect();
  try {
    const result = await certifyRawScrubRange(db, store, {
      startAfter: values["start-after"],
      inventoryLimit: values["inventory-limit"] === undefined ? undefined : Number(values["inventory-limit"]),
      snapshotLimit: values["snapshot-limit"] === undefined ? undefined : Number(values["snapshot-limit"]),
      wireByteLimit: values["wire-byte-limit"] === undefined ? undefined : Number(values["wire-byte-limit"]),
    }, values.receipt, code);
    console.log(JSON.stringify({ status: result.status, range: result.range, counts: result.counts,
      ...(result.status === "failed" ? { changed: result.changed, findings: result.findings } : {}) }));
    if (result.status === "failed") process.exitCode = 1;
  } finally {
    await db.end();
  }
};

try { await run(); }
catch (error) {
  // Keep connection strings and server details out of command diagnostics.
  const message = error instanceof Error && /^(integrity-scrub-|FS170_DATABASE_URL |absolute --root )/.test(error.message)
    ? error.message : (error as NodeJS.ErrnoException)?.code ?? "integrity-scrub-failed";
  console.error(JSON.stringify({ status: "failed", reason: message }));
  process.exitCode = 1;
}
