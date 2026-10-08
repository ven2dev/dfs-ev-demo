// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionsFile } from "../../src/lib/creatorDecisions.ts";
import { createDecisionStore } from "./decisionStore.ts";
import { NOW, discoveryFor, record, vid } from "./testSupport.ts";

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "creator-corpus-decisions-"));
  path = join(directory, "decisions.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "accepted";
};
const onDisk = async (): Promise<DecisionsFile> => JSON.parse(await readFile(path, "utf8"));
const request = (n: number, overrides: Record<string, unknown> = {}) => ({
  creatorKey: "creator-a",
  videoId: vid(n),
  decision: "include" as const,
  reason: "props throughout",
  ...overrides,
});

describe("append", () => {
  it("creates an owner-only log whose event carries the server's rule version and time", async () => {
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1)]), now: () => NOW });
    const event = await store.append(request(1));
    expect(event).toEqual({
      videoId: vid(1),
      decision: "include",
      reason: "props throughout",
      ruleVersion: "v1",
      decidedAt: NOW.toISOString(),
    });
    expect(await onDisk()).toEqual({ "creator-a": [event] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("ignores any rule version or time a caller tries to supply", async () => {
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1)]), now: () => NOW });
    const event = await store.append({ ...request(1), ruleVersion: "v9", decidedAt: "2001-01-01T00:00:00.000Z" } as never);
    expect(event).toMatchObject({ ruleVersion: "v1", decidedAt: NOW.toISOString() });
  });

  it("keeps every earlier event, trims the reason, and leaves no temporary files", async () => {
    let tick = 0;
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1)]), now: () => new Date(NOW.getTime() + tick++ * 1000) });
    await store.append(request(1, { reason: "  first  " }));
    await store.append(request(1, { decision: "exclude", reason: "second" }));
    await store.append(request(1, { decision: "clear", reason: "reconsidering after the full video" }));
    const events = (await onDisk())["creator-a"];
    expect(events.map((event) => [event.decision, event.reason])).toEqual([
      ["include", "first"],
      ["exclude", "second"],
      ["clear", "reconsidering after the full video"],
    ]);
    expect(await readdir(directory)).toEqual(["decisions.json"]);
  });

  it("keeps each creator's events separate", async () => {
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1)], [record(900)]), now: () => NOW });
    await store.append(request(1));
    await store.append({ ...request(900), creatorKey: "creator-b" });
    const file = await onDisk();
    expect(Object.keys(file).sort()).toEqual(["creator-a", "creator-b"]);
    expect(file["creator-b"][0].videoId).toBe(vid(900));
  });
});

describe("validation", () => {
  const rejects: [string, () => Record<string, unknown>, string][] = [
    ["an unknown creator", () => ({ creatorKey: "creator-z" }), "unknown-creator-key"],
    ["a video from another creator", () => ({ videoId: vid(900) }), "unknown-video"],
    ["an unknown video", () => ({ videoId: vid(55) }), "unknown-video"],
    ["a blank reason", () => ({ reason: "   " }), "reason-required"],
    ["a missing reason", () => ({ reason: undefined }), "reason-required"],
    ["an over-long reason", () => ({ reason: "x".repeat(501) }), "reason-too-long"],
    ["an unknown decision", () => ({ decision: "approve" }), "invalid-decision"],
    ["clearing a video with no active decision", () => ({ decision: "clear" }), "nothing-to-clear"],
  ];
  it.each(rejects)("refuses %s without touching the file", async (_name, overrides, code) => {
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1)]), now: () => NOW });
    expect(await codeOf(store.append({ ...request(1), ...overrides() } as never))).toBe(code);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses decisions for videos outside the registered window", async () => {
    const outside = [
      record(2, { publishedAt: "2025-02-01T12:00:00Z" }),
      record(3, { publishedAt: "2026-10-08T12:00:00Z" }),
    ];
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1), ...outside]), now: () => NOW });
    expect(await codeOf(store.append(request(2)))).toBe("video-outside-window");
    expect(await codeOf(store.append(request(3)))).toBe("video-outside-window");
    await store.append(request(1));
  });

  it("allows clearing only once a decision is active, and again after a new one", async () => {
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1)]), now: () => NOW });
    await store.append(request(1));
    await store.append(request(1, { decision: "clear", reason: "unsure" }));
    expect(await codeOf(store.append(request(1, { decision: "clear", reason: "again" })))).toBe("nothing-to-clear");
    await store.append(request(1, { decision: "exclude", reason: "recap" }));
    await store.append(request(1, { decision: "clear", reason: "unsure again" }));
    expect((await onDisk())["creator-a"]).toHaveLength(4);
  });

  it("blocks all decisions when the discovery data is stale", async () => {
    const stale = discoveryFor([record(1, { apiFetchedAt: "2026-08-01T00:00:00.000Z" })]);
    const store = createDecisionStore({ path, discovery: stale, now: () => NOW });
    expect(await codeOf(store.append(request(1)))).toBe("stale-discovery-data");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites a decisions file it cannot understand", async () => {
    await writeFile(path, "{ this is not json");
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1)]), now: () => NOW });
    expect(await codeOf(store.append(request(1)))).toBe("input-unreadable");
    expect(await readFile(path, "utf8")).toBe("{ this is not json");
    await writeFile(path, JSON.stringify({ "creator-a": [{ videoId: vid(1), decision: "include", reason: "old format" }] }));
    expect(await codeOf(store.append(request(1)))).toBe("invalid-decisions-file");
  });

  it("refuses a location inside the repository", async () => {
    const store = createDecisionStore({ path: join(process.cwd(), "should-not-exist.json"), discovery: discoveryFor([record(1)]), now: () => NOW });
    expect(await codeOf(store.append(request(1)))).toBe("must-be-outside-repository");
  });
});

describe("concurrency", () => {
  it("never loses a decision when many requests overlap", async () => {
    const videos = Array.from({ length: 25 }, (_, index) => record(index + 1));
    const store = createDecisionStore({ path, discovery: discoveryFor(videos), now: () => NOW });
    await Promise.all(videos.map((video) => store.append(request(Number(video.videoId.slice(3))))));
    const events = (await onDisk())["creator-a"];
    expect(events).toHaveLength(25);
    expect(new Set(events.map((event) => event.videoId)).size).toBe(25);
  });

  it("applies overlapping requests for one video in arrival order", async () => {
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1)]), now: () => NOW });
    const results = await Promise.allSettled([
      store.append(request(1, { reason: "first" })),
      store.append(request(1, { decision: "exclude", reason: "second" })),
      store.append(request(1, { decision: "clear", reason: "third" })),
      store.append(request(1, { decision: "include", reason: "fourth" })),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect((await onDisk())["creator-a"].map((event) => event.reason)).toEqual(["first", "second", "third", "fourth"]);
  });

  it("keeps serving requests after one fails", async () => {
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1), record(2)]), now: () => NOW });
    const results = await Promise.allSettled([
      store.append(request(1, { reason: "" })),
      store.append(request(2)),
      store.append(request(55)),
      store.append(request(1)),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "rejected", "fulfilled"]);
    expect((await onDisk())["creator-a"].map((event) => event.videoId)).toEqual([vid(2), vid(1)]);
  });

  it("reads the log in sequence with pending writes", async () => {
    const store = createDecisionStore({ path, discovery: discoveryFor([record(1)]), now: () => NOW });
    const write = store.append(request(1));
    const read = store.read();
    await write;
    expect((await read)["creator-a"]).toHaveLength(1);
  });
});

describe("a creator whose key is named like an Object property", () => {
  it("records and reads decisions for a creator named constructor", async () => {
    const discovery = discoveryFor([record(1)]);
    discovery.creators[0].key = "constructor";
    discovery.creators[0].manifest.creatorKey = "constructor";
    const store = createDecisionStore({ path, discovery, now: () => NOW });
    await store.append({ creatorKey: "constructor", videoId: vid(1), decision: "include", reason: "r" });
    await store.append({ creatorKey: "constructor", videoId: vid(1), decision: "clear", reason: "unsure" });
    expect(Object.keys(await store.read())).toEqual(["constructor"]);
    expect((await onDisk()).constructor).toHaveLength(2);
  });
});

describe("two review processes on the same log", () => {
  // Two stores have independent in-process queues, exactly like two separate
  // review commands. Only the file lock keeps them from overwriting each other.
  it("never lose each other's decisions", async () => {
    const videos = Array.from({ length: 60 }, (_, index) => record(index + 1));
    const discovery = discoveryFor(videos);
    const first = createDecisionStore({ path, discovery, now: () => NOW });
    const second = createDecisionStore({ path, discovery, now: () => NOW });
    await Promise.all(
      videos.map((video, index) => (index % 2 === 0 ? first : second).append(request(Number(video.videoId.slice(3)))))
    );
    const events = (await onDisk())["creator-a"];
    expect(events).toHaveLength(60);
    expect(new Set(events.map((event) => event.videoId)).size).toBe(60);
    expect((await readdir(directory)).sort()).toEqual(["decisions.json"]);
  });

  it("fail with a fixed code, and lose nothing, when the lock is held too long", async () => {
    const discovery = discoveryFor([record(1)]);
    const store = createDecisionStore({ path, discovery, now: () => NOW });
    await store.append(request(1));
    await writeFile(join(directory, ".decisions.json.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const slow = createDecisionStore({ path, discovery, now: () => NOW, lock: { timeoutMs: 100 } });
    expect(await codeOf(slow.append(request(1, { reason: "second" })))).toBe("file-busy");
    expect((await onDisk())["creator-a"]).toHaveLength(1);
  });
});
