// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_TRANSCRIPT_BYTES, hashTranscript, parseCaptureLog } from "../../src/lib/creatorCaptures.ts";
import type { DecisionsFile } from "../../src/lib/creatorDecisions.ts";
import { createCaptureStore, readCapturesFile } from "./captureStore.ts";
import { NOW, discoveryFor, record, vid } from "./testSupport.ts";

const TEXT = "0:00\nWelcome back to the show, everybody.\n0:07\nLet us get into the props.\n".repeat(8);
let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "creator-corpus-captures-"));
  path = join(directory, "captures.jsonl");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

// An included video by the rule (a prop title). Videos 5 and 6 are flagged for
// review and excluded by the rule.
const prop = (n: number, overrides: Record<string, unknown> = {}) => record(n, { title: "NFL Week 6 Player Props", ...overrides });
const discovery = () =>
  discoveryFor([
    prop(1),
    prop(2),
    prop(3, { publishedAt: "2025-02-01T12:00:00Z" }),
    prop(4, { publishedAt: "2026-10-08T12:00:00Z" }),
    record(5, { title: "Week 6 NFL best bets and picks" }),
    record(6, { title: "NFL Week 6 reaction and recap" }),
  ]);
const store = (options: { discovery?: ReturnType<typeof discoveryFor>; lock?: { timeoutMs?: number }; decisions?: () => Promise<DecisionsFile> } = {}) =>
  createCaptureStore({ path, discovery: options.discovery ?? discovery(), now: () => NOW, lock: options.lock, decisions: options.decisions });
const capture = (n: number, overrides: Record<string, unknown> = {}) => ({
  creatorKey: "creator-a",
  videoId: vid(n),
  action: "capture" as const,
  text: TEXT,
  publishedDate: "2025-10-09",
  ...overrides,
});
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "accepted";
};
const lines = async () => (await readFile(path, "utf8")).split("\n").filter(Boolean);
const absent = async () => expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

describe("append", () => {
  it("creates an owner-only log with one verified line and leaves nothing else behind", async () => {
    const event = await store().append(capture(1));
    expect(event).toMatchObject({
      event: "captured",
      creatorKey: "creator-a",
      videoId: vid(1),
      capturedAt: NOW.toISOString(),
      source: "manual-owner-paste",
      usageStatus: "internal-research-only",
      text: TEXT,
      sha256: hashTranscript(TEXT),
      characters: TEXT.length,
    });
    expect(await lines()).toEqual([JSON.stringify(event)]);
    expect(parseCaptureLog(await readFile(path, "utf8"))).toEqual([event]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["captures.jsonl"]);
  });

  it("ignores any time, source, hash or length a caller tries to supply", async () => {
    const event = await store().append({
      ...capture(1),
      capturedAt: "2001-01-01T00:00:00.000Z",
      source: "scraper",
      sha256: "0".repeat(64),
      characters: 1,
    } as never);
    expect(event).toMatchObject({ capturedAt: NOW.toISOString(), source: "manual-owner-paste", sha256: hashTranscript(TEXT), characters: TEXT.length });
  });

  it("appends replace and unavailable events in order, keeping every earlier line untouched", async () => {
    const s = store();
    const first = await s.append(capture(1));
    await s.append({ creatorKey: "creator-a", videoId: vid(2), action: "unavailable", publishedDate: "2025-10-09", reason: "captions disabled" });
    const replaced = await s.append(capture(1, { action: "replace", reason: "pasted the wrong video", text: TEXT + "tail\n" }));
    const written = await lines();
    expect(written).toHaveLength(3);
    expect(written[0]).toBe(JSON.stringify(first));
    expect(replaced).toMatchObject({ event: "replaced", reason: "pasted the wrong video" });
    expect((await s.read()).map((event) => [event.videoId, event.event])).toEqual([
      [vid(1), "captured"],
      [vid(2), "unavailable"],
      [vid(1), "replaced"],
    ]);
  });

  it("lets a video first marked unavailable be captured later", async () => {
    const s = store();
    await s.append({ creatorKey: "creator-a", videoId: vid(1), action: "unavailable", publishedDate: "2025-10-09" });
    await s.append(capture(1));
    expect((await s.read()).map((event) => event.event)).toEqual(["unavailable", "captured"]);
  });

  it("stores a transcript at the size limit and reads it back byte for byte", async () => {
    const big = "x".repeat(MAX_TRANSCRIPT_BYTES - 1) + "\n";
    const s = store();
    await s.append(capture(1, { text: big }));
    const [event] = await s.read();
    expect(event.text).toBe(big);
    expect(event.sha256).toBe(hashTranscript(big));
    expect(await lines()).toHaveLength(1);
  });

  it("works for a creator whose key is named like an Object property", async () => {
    const d = discovery();
    d.creators[0].key = "constructor";
    d.creators[0].manifest.creatorKey = "constructor";
    await store({ discovery: d }).append(capture(1, { creatorKey: "constructor" }));
    expect((await readCapturesFile(path))[0].creatorKey).toBe("constructor");
  });
});

describe("refusals", () => {
  const refuses: [string, () => Record<string, unknown>, string][] = [
    ["an unknown creator", () => capture(1, { creatorKey: "creator-z" }), "unknown-creator-key"],
    ["a video of another creator", () => capture(900), "unknown-video"],
    ["an unknown video", () => capture(55), "unknown-video"],
    ["a video before the window", () => capture(3), "video-outside-window"],
    ["a video after the window", () => capture(4), "video-outside-window"],
    ["empty text", () => capture(1, { text: "  \n " }), "transcript-empty"],
    ["text with control characters", () => capture(1, { text: TEXT + "\u0000" }), "transcript-invalid-characters"],
    ["text over the limit", () => capture(1, { text: "x".repeat(MAX_TRANSCRIPT_BYTES + 1) }), "transcript-too-large"],
    ["short text without confirmation", () => capture(1, { text: "short" }), "transcript-too-short"],
    ["a missing date", () => capture(1, { publishedDate: undefined }), "invalid-published-date"],
    ["an impossible date", () => capture(1, { publishedDate: "2025-02-30" }), "invalid-published-date"],
    ["replacing with nothing captured", () => capture(1, { action: "replace", reason: "fix" }), "nothing-to-replace"],
    ["replacing without a reason", () => capture(1, { action: "replace" }), "reason-required"],
    ["an unknown action", () => capture(1, { action: "delete" }), "invalid-capture-action"],
  ];
  it.each(refuses)("refuses %s and writes nothing", async (_name, make, code) => {
    expect(await codeOf(store().append(make() as never))).toBe(code);
    await absent();
  });

  it("refuses a second capture, a capture after unavailable twice, and unavailable after a capture", async () => {
    const s = store();
    await s.append(capture(1));
    await s.append({ creatorKey: "creator-a", videoId: vid(2), action: "unavailable", publishedDate: "2025-10-09" });
    const before = await readFile(path, "utf8");
    expect(await codeOf(s.append(capture(1)))).toBe("already-captured");
    expect(await codeOf(s.append({ creatorKey: "creator-a", videoId: vid(1), action: "unavailable", publishedDate: "2025-10-09" }))).toBe("already-captured");
    expect(await codeOf(s.append({ creatorKey: "creator-a", videoId: vid(2), action: "unavailable", publishedDate: "2025-10-09" }))).toBe("already-unavailable");
    expect(await codeOf(s.append(capture(2, { action: "replace", reason: "fix" })))).toBe("nothing-to-replace");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("blocks every capture when the discovery data is stale", async () => {
    const stale = discoveryFor([prop(1, { apiFetchedAt: "2026-08-01T00:00:00.000Z" })]);
    expect(await codeOf(store({ discovery: stale }).append(capture(1)))).toBe("stale-discovery-data");
    await absent();
  });

  it("never puts the transcript into an error", async () => {
    try {
      await store().append(capture(1, { text: "SECRET-TRANSCRIPT-BODY\u0000" }));
    } catch (error) {
      expect(JSON.stringify(error) + String(error) + (error as Error).message).not.toContain("SECRET-TRANSCRIPT-BODY");
    }
  });
});

describe("a log that cannot be trusted", () => {
  it("is never appended to or repaired", async () => {
    const s = store();
    await s.append(capture(1));
    const original = await readFile(path, "utf8");
    const damages: [string, string][] = [
      ["edited text", original.replace("Welcome back", "Welcome BACK")],
      ["a cut-short last line", original.slice(0, -1)],
      ["garbage", original + "not json\n"],
      ["a duplicate capture", original + original],
    ];
    for (const [name, content] of damages) {
      await writeFile(path, content);
      expect(await codeOf(s.append(capture(2))), name).toBe("invalid-captures-file");
      expect(await codeOf(s.read()), name).toBe("invalid-captures-file");
      expect(await readFile(path, "utf8"), name).toBe(content);
    }
  });
});

describe("location rules", () => {
  it("require a .jsonl file outside the repository that is not a link", async () => {
    const d = discovery();
    expect(await codeOf(createCaptureStore({ path: join(directory, "captures.json"), discovery: d, now: () => NOW }).append(capture(1)))).toBe(
      "jsonl-file-required"
    );
    expect(await codeOf(createCaptureStore({ path: join(process.cwd(), "captures-test.jsonl"), discovery: d, now: () => NOW }).append(capture(1)))).toBe(
      "must-be-outside-repository"
    );
    await writeFile(join(directory, "real.jsonl"), "");
    await symlink(join(directory, "real.jsonl"), join(directory, "alias.jsonl"));
    expect(await codeOf(createCaptureStore({ path: join(directory, "alias.jsonl"), discovery: d, now: () => NOW }).append(capture(1)))).toBe(
      "symlink-not-allowed"
    );
  });
});

describe("concurrency", () => {
  it("never loses or interleaves an event across two independent stores", async () => {
    const many = discoveryFor(Array.from({ length: 60 }, (_, index) => prop(index + 1)));
    const first = store({ discovery: many });
    const second = store({ discovery: many });
    await Promise.all(Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? first : second).append(capture(index + 1))));
    const events = parseCaptureLog(await readFile(path, "utf8"));
    expect(events).toHaveLength(60);
    expect(new Set(events.map((event) => event.videoId)).size).toBe(60);
    expect(await readdir(directory)).toEqual(["captures.jsonl"]);
  });

  it("lets exactly one of two racing captures of the same video win", async () => {
    const results = await Promise.allSettled([store().append(capture(1)), store().append(capture(1)), store().append(capture(1))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.code)).toEqual([
      "already-captured",
      "already-captured",
    ]);
    expect(await lines()).toHaveLength(1);
  });

  it("fails with a fixed code and loses nothing when the lock is held too long", async () => {
    const s = store();
    await s.append(capture(1));
    await writeFile(join(directory, ".captures.jsonl.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(await codeOf(store({ lock: { timeoutMs: 100 } }).append(capture(2)))).toBe("file-busy");
    expect(await lines()).toHaveLength(1);
  });

  it("keeps serving requests after one fails", async () => {
    const s = store();
    const results = await Promise.allSettled([s.append(capture(1, { text: "" })), s.append(capture(2)), s.append(capture(55)), s.append(capture(1))]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "rejected", "fulfilled"]);
    expect((await readCapturesFile(path)).map((event) => event.videoId)).toEqual([vid(2), vid(1)]);
  });
});

const decision = (videoId: string, kind: "include" | "exclude" | "clear"): DecisionsFile => ({
  "creator-a": [{ videoId, decision: kind, reason: "owner decision", ruleVersion: "v1", decidedAt: NOW.toISOString() }],
});

describe("only videos in the queue can be captured", () => {
  it("refuses a video the rule excluded, for every action and scope, and writes nothing", async () => {
    for (const scope of ["included", "included-and-flagged"] as const) {
      for (const action of ["capture", "unavailable"] as const) {
        const request = action === "capture" ? capture(6) : { creatorKey: "creator-a", videoId: vid(6), action, publishedDate: "2025-10-09" };
        expect(await codeOf(store().append(request, scope)), `${action} ${scope}`).toBe("video-not-in-queue");
      }
    }
    expect(await codeOf(store().append({ creatorKey: "creator-a", videoId: vid(6), action: "replace", reason: "x", text: TEXT, publishedDate: "2025-10-09" }))).toBe(
      "video-not-in-queue"
    );
    await absent();
  });

  it("refuses a flagged video under the narrow scope and accepts it under the wide one", async () => {
    expect(await codeOf(store().append(capture(5)))).toBe("video-not-in-queue");
    expect(await codeOf(store().append(capture(5), "included"))).toBe("video-not-in-queue");
    await absent();
    expect(await codeOf(store().append(capture(5), "included-and-flagged"))).toBe("accepted");
    expect((await lines()).length).toBe(1);
  });

  it("follows the owner's current decisions, read at the moment of each save", async () => {
    let current: DecisionsFile = {};
    const s = store({ decisions: async () => current });
    expect(await codeOf(s.append(capture(5)))).toBe("video-not-in-queue");
    current = decision(vid(5), "include");
    expect(await codeOf(s.append(capture(5)))).toBe("accepted");
    current = decision(vid(1), "exclude");
    expect(await codeOf(s.append(capture(1)))).toBe("video-not-in-queue");
    expect(await codeOf(s.append(capture(2)))).toBe("accepted");
    current = decision(vid(1), "clear");
    expect(await codeOf(s.append(capture(1)))).toBe("accepted");
  });

  it("applies the rules in order: unknown creator or video, then window, then eligibility", async () => {
    expect(await codeOf(store().append(capture(1, { creatorKey: "creator-z" })))).toBe("unknown-creator-key");
    expect(await codeOf(store().append(capture(99)))).toBe("unknown-video");
    expect(await codeOf(store().append(capture(3)))).toBe("video-outside-window");
  });

  it("keeps an earlier capture in the log after the owner excludes the video, and refuses any new event for it", async () => {
    let current: DecisionsFile = {};
    const s = store({ decisions: async () => current });
    await s.append(capture(1));
    current = decision(vid(1), "exclude");
    expect(await codeOf(s.append(capture(1, { action: "replace", reason: "again" })))).toBe("video-not-in-queue");
    expect((await s.read()).map((event) => event.videoId)).toEqual([vid(1)]);
  });
});

describe("the confirmed publish date", () => {
  it("is required, valid and stored for an unavailable video too", async () => {
    const unavailable = (overrides: Record<string, unknown> = {}) => ({ creatorKey: "creator-a", videoId: vid(1), action: "unavailable" as const, ...overrides });
    expect(await codeOf(store().append(unavailable()))).toBe("invalid-published-date");
    expect(await codeOf(store().append(unavailable({ publishedDate: "2025-02-30" })))).toBe("invalid-published-date");
    await absent();
    const event = await store().append(unavailable({ publishedDate: "2025-10-09" }));
    expect(event).toMatchObject({ event: "unavailable", publishedDate: "2025-10-09", text: null, sha256: null });
    expect((await store().read())[0]).toEqual(event);
  });
});

describe("the text is kept exactly", () => {
  it("keeps a leading byte-order mark and every other character, changing only line endings", async () => {
    const text = "\uFEFF" + TEXT.replaceAll("\n", "\r\n") + "  trailing spaces  \t\n";
    const event = await store().append(capture(1, { text }));
    const expected = text.replaceAll("\r\n", "\n");
    expect(event.text).toBe(expected);
    expect(event.text!.startsWith("\uFEFF")).toBe(true);
    expect(event.sha256).toBe(hashTranscript(expected));
    expect(event.characters).toBe(expected.length);
    expect((await store().read())[0]!.text).toBe(expected);
  });
});
