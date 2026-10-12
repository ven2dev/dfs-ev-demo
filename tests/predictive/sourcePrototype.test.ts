import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openArtifactStore, type ArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { captureSourcePrototype, verifySourcePrototype } from "../../src/lib/predictive/sourcePrototype.ts";
import { SOURCE_LIMITS } from "../../src/lib/predictive/sourceTransport.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { runSourcePrototype } from "../../scripts/predictive/source.ts";
import { fixtureTransport, sourceGameId } from "./fixtures/source.ts";

const roots: string[] = [];
const privateRoot = async () => { const root = await realpath(await mkdtemp(join(tmpdir(), "dfs-ev-source-test-"))); roots.push(root); return root; };
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const storedJournal = async (store: ArtifactStore, report: unknown) => {
  const bytes = canonical(report); const sha256 = digest(bytes);
  return { reference: await store.write(bytes, sha256), sha256, byteSize: Buffer.byteLength(bytes) };
};
const setup = async (options: Parameters<typeof fixtureTransport>[0] = {}) => {
  const directory = await privateRoot(); const store = await openArtifactStore(directory, SOURCE_LIMITS.responseBytes);
  const fixture = fixtureTransport(options);
  const result = await captureSourcePrototype(store, 2026, sourceGameId, fixture.transport, options?.limits);
  return { ...result, ...fixture, directory, store };
};
it("captures exact bases, journals their timestamps and restores the same projection without any feature publication", async () => {
  const { directory, report, journal, store } = await setup();
  expect(report.status).toBe("captured"); expect(report.featuresPublished).toBe(false); expect(report.metrics.requests).toBe(14);
  // One row in five feeds, two identifiers and two weekly roster rows.
  expect(report.metrics.rows).toBe(9); expect(report.captures).toHaveLength(7);
  expect(report.captures.every((capture) => capture.state === "captured" && capture.sourcePublishedAt === null && capture.availableAt === capture.capturedAt)).toBe(true);
  expect(report.captures[0].upstreamUpdatedAt).toBe("2026-10-08T12:00:00Z");
  expect(report.captures[0].availableAt).toBe("2026-10-09T12:00:00.000Z");
  const verified = await verifySourcePrototype(await openArtifactStore(directory, SOURCE_LIMITS.responseBytes), journal);
  expect(verified).toMatchObject({ verified: true, featuresPublished: false, captures: 7, qualification: report.qualification });
  expect(report.qualification?.featureStatus).toBe("unavailable-inputs");
  const source = report.captures[0].source!;
  expect(await readFile(join(directory, source.reference), "utf8")).toBe(await store.read(source.reference, source.sha256, source.byteSize));
});
it("keeps an oversized depth probe incomplete and verifies its header and exact range offline", async () => {
  const { report, journal, store } = await setup({ partialDepth: true });
  expect(report.status).toBe("incomplete"); expect(report.failureCode).toBeNull(); expect(report.featuresPublished).toBe(false);
  expect(report.captures[6]).toMatchObject({ state: "header-only", rows: 0, failureCode: "source-file-over-budget", upstreamBytes: 59_000_000 });
  expect(report.captures[6].source!.byteSize).toBeLessThan(4096);
  expect(report.qualification?.reasons).toContain("depth-capture-incomplete");
  await expect(verifySourcePrototype(store, journal)).resolves.toMatchObject({ verified: true, featuresPublished: false });
  report.captures[6].sourceContentRange = "bytes 0-99/59000000";
  await expect(verifySourcePrototype(store, await storedJournal(store, report))).rejects.toThrow("source-journal-refused");
});
it.each(["HTTP", "header", "digest"])("journals %s refusal, stops acquisition and keeps diagnostics outside publication", async (kind) => {
  const options = kind === "HTTP" ? { failFeed: "team" as const } : kind === "header" ? { badHeader: "team" as const } : { badDigest: "team" as const };
  const { report, journal, store, fetched } = await setup(options);
  expect(report.status).toBe("refused"); expect(report.featuresPublished).toBe(false); expect(report.captures).toHaveLength(2); expect(fetched).toHaveLength(4);
  expect(report.captures[1]).toMatchObject({ state: "refused", rows: 0, headerSha256: null });
  expect(report.captures[1].failureCode).toBe(kind === "HTTP" ? "source-http-refused" : kind === "header" ? "source-header-drift" : "source-release-integrity-failed");
  await expect(verifySourcePrototype(store, journal)).resolves.toMatchObject({ verified: true, featuresPublished: false, qualification: null });
});
it("enforces a shared parsed-row ceiling across feeds without expanding it", async () => {
  const limits = { ...SOURCE_LIMITS, rows: 1 };
  const { report, journal, store } = await setup({ limits });
  expect(report.status).toBe("refused"); expect(report.failureCode).toBe("source-row-bound-refused"); expect(report.metrics.rows).toBe(1);
  await expect(verifySourcePrototype(store, journal)).resolves.toMatchObject({ verified: true, featuresPublished: false });
});
it.each(["published", "missing-qualification", "metrics", "missing-feed", "feed-order", "unknown-state", "extra-field", "backdated",
  "source-published", "wrong-header-hash", "bad-reference", "rights", "status", "missing-source"])("refuses a rehashed journal with %s corruption", async (kind) => {
  const { report, store } = await setup();
  const changed = JSON.parse(JSON.stringify(report));
  switch (kind) {
    case "published": changed.featuresPublished = true; break;
    case "missing-qualification": changed.qualification = null; break;
    case "metrics": changed.metrics.rows++; break;
    case "missing-feed": changed.captures.pop(); break;
    case "feed-order": [changed.captures[0], changed.captures[1]] = [changed.captures[1], changed.captures[0]]; break;
    case "unknown-state": changed.captures[0].state = "published"; break;
    case "extra-field": changed.captures[0].unreviewed = true; break;
    case "backdated": changed.captures[0].availableAt = changed.captures[0].upstreamUpdatedAt; break;
    case "source-published": changed.captures[0].sourcePublishedAt = changed.captures[0].capturedAt; break;
    case "wrong-header-hash": changed.captures[0].headerSha256 = "a".repeat(64); break;
    case "bad-reference": changed.captures[0].source.reference = "../" + changed.captures[0].source.reference; break;
    case "rights": changed.usage = "public-serving"; break;
    case "status": changed.status = "incomplete"; break;
    case "missing-source": changed.captures[0].source = null; break;
  }
  const code = kind === "missing-qualification" ? "source-restoration-mismatch" : kind === "extra-field" ? "schema-fields-refused" : "source-journal-refused";
  await expect(verifySourcePrototype(store, await storedJournal(store, changed))).rejects.toMatchObject({ code });
});
it("refuses tampered or missing exact source files on offline restoration", async () => {
  const { report, journal, store, directory } = await setup();
  const source = report.captures[0].source!; const path = join(directory, source.reference);
  const bytes = await readFile(path, "utf8"); await writeFile(path, bytes.replace('"80"', '"81"'));
  await expect(verifySourcePrototype(store, journal)).rejects.toThrow("artifact-integrity-failed");
  await rm(path); await expect(verifySourcePrototype(store, journal)).rejects.toMatchObject({ code: "ENOENT" });
});
it("validates arguments and ambient credentials before registering any artifact directory", async () => {
  const directory = await privateRoot();
  const cases = [[], ["bad", "--artifact-root", directory], ["capture", "--artifact-root", directory, "--season", "2025", "--game-id", sourceGameId],
    ["capture", "--artifact-root", directory, "--season", "2026", "--game-id", "2025_06_CAR_PHI"],
    ["verify", "--artifact-root", directory, "--journal", "a".repeat(64) + ".json", "--journal-bytes", "9007199254740993"]];
  for (const args of cases) await expect(runSourcePrototype(args, { NODE_ENV: "test" })).rejects.toThrow();
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL", "GH_TOKEN", "GITHUB_TOKEN", "NEON_API_KEY"])
    await expect(runSourcePrototype(["capture", "--artifact-root", directory, "--season", "2026", "--game-id", sourceGameId], { NODE_ENV: "test", [key]: "" })).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});
it("keeps the synthetic artifact size cap as default while allowing an explicit bounded source store", async () => {
  const directory = await privateRoot(); const bytes = "x".repeat(1_000_001); const sha = digest(bytes);
  await expect((await openArtifactStore(directory)).write(bytes, sha)).rejects.toThrow("artifact-integrity-failed");
  const store = await openArtifactStore(directory, 2_000_000); const reference = await store.write(bytes, sha);
  expect((await store.read(reference, sha, bytes.length)).length).toBe(1_000_001);
  await expect((await openArtifactStore(directory)).read(reference, sha, bytes.length)).rejects.toThrow("artifact-reference-refused");
  for (const limit of [0, 8_000_001, 1.1]) await expect(openArtifactStore(directory, limit)).rejects.toThrow("artifact-size-bound-refused");
});
