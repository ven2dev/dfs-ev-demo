import { constants } from "node:fs";
import { open, realpath, stat, lstat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCompressedSource, COMPRESSED_SOURCE_LIMITS, type CompressedFeed } from "../../src/lib/predictive/compressedSource.ts";
import { assertNoApplicationCredentials } from "../../tests/db/target.mts";

export async function runCompressedInspection(args: string[], environment: NodeJS.ProcessEnv) {
  assertNoApplicationCredentials(environment);
  const [feedFlag, feed, seasonFlag, season, fileFlag, file, shaFlag, wireSha256, bytesFlag, wireBytes, ...extra] = args;
  if (feedFlag !== "--feed" || !["player", "team", "roster"].includes(feed) || seasonFlag !== "--season" || !["2025", "2026"].includes(season) ||
      fileFlag !== "--file" || !file || shaFlag !== "--sha256" || !/^[a-f0-9]{64}$/.test(wireSha256 ?? "") || bytesFlag !== "--bytes" ||
      !/^\d+$/.test(wireBytes ?? "") || !Number.isSafeInteger(Number(wireBytes)) || Number(wireBytes) < 1 ||
      Number(wireBytes) > COMPRESSED_SOURCE_LIMITS.wireBytes || extra.length) throw new Error("compressed-inspection-arguments-refused");
  const repository = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  const suppliedRoot = dirname(resolve(file));
  if ((await lstat(suppliedRoot)).isSymbolicLink()) throw new Error("compressed-inspection-file-refused");
  const root = await realpath(suppliedRoot);
  const within = relative(repository, root);
  const directory = await stat(root);
  if (within === "" || (!within.startsWith(".." + sep) && within !== ".." && !within.startsWith(sep)) || (directory.mode & 0o077) !== 0) throw new Error("compressed-inspection-file-refused");
  const handle = await open(resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size !== Number(wireBytes)) throw new Error("compressed-inspection-file-refused");
    const bytes = Buffer.alloc(Number(wireBytes) + 1);
    let read = 0;
    while (read < bytes.length) {
      const part = await handle.read(bytes, read, bytes.length - read, read);
      if (part.bytesRead === 0) break;
      read += part.bytesRead;
    }
    const after = await handle.stat();
    if (read !== Number(wireBytes) || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("compressed-inspection-file-refused");
    return await inspectCompressedSource(bytes.subarray(0, read), { feed: feed as CompressedFeed, season: Number(season) as 2025 | 2026,
      wireSha256, wireBytes: Number(wireBytes) });
  } finally { await handle.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const started = performance.now();
    const report = await runCompressedInspection(process.argv.slice(2), process.env);
    console.log(JSON.stringify({ ...report, measurements: { elapsedMs: Math.ceil(performance.now() - started),
      peakRssBytes: process.resourceUsage().maxRSS * 1024 } }, null, 2));
  }
  catch (error) { console.error(error instanceof Error ? error.message : "compressed-inspection-refused"); process.exitCode = 1; }
}
