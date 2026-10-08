// @vitest-environment node
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_TRANSCRIPT_BYTES, parseCaptureLog } from "../../src/lib/creatorCaptures.ts";
import { MAX_BODY_BYTES, MAX_CAPTURE_BODY_BYTES, startReviewServer, type ReviewServer } from "./reviewServer.ts";
import { NOW, discoveryFor, record, vid } from "./testSupport.ts";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// node:http, not fetch: the tests must control Host, Origin and body framing.
const call = (
  server: ReviewServer,
  { method = "GET", path = "/", headers = {}, body }: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port: server.port, method, path, headers: { Host: `127.0.0.1:${server.port}`, ...headers } },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
      }
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });

const SENTINEL = "SENTINEL-TRANSCRIPT-WORDS";
const TEXT = `0:00\n${SENTINEL} welcome to the show.\n`.repeat(20);
let directory: string;
let decisionsPath: string;
let capturesPath: string;
let server: ReviewServer;

// 1: included, 2: flagged, 3: excluded, 4: included.
const discovery = () =>
  discoveryFor([
    record(1, { title: "NFL Week 6 Player Props", publishedAt: "2025-10-09T15:00:00Z" }),
    record(2, { title: "Week 6 NFL best bets and picks", publishedAt: "2025-10-08T15:00:00Z" }),
    record(3, { title: "NFL Week 6 reaction and recap", publishedAt: "2025-10-10T15:00:00Z" }),
    record(4, { title: "NFL Week 7 Player Props", publishedAt: "2025-10-16T15:00:00Z" }),
  ]);
const start = async (overrides: Partial<Parameters<typeof startReviewServer>[0]> = {}) => {
  server = await startReviewServer({ discovery: discovery(), decisionsPath, capturesPath, now: () => NOW, ...overrides });
  return server;
};
const auth = () => ({ Authorization: `Bearer ${server.token}` });
const post = (body: unknown, headers: Record<string, string> = {}, path = "/api/capture") =>
  call(server, {
    method: "POST",
    path,
    headers: { ...auth(), Origin: `http://127.0.0.1:${server.port}`, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
const capture = (overrides: Record<string, unknown> = {}) => ({
  creatorKey: "creator-a",
  videoId: vid(1),
  action: "capture",
  text: TEXT,
  publishedDate: "2025-10-09",
  ...overrides,
});
const queue = async (query = "") => JSON.parse((await call(server, { path: `/api/captures${query}`, headers: auth() })).body);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "creator-corpus-capture-server-"));
  decisionsPath = join(directory, "decisions.json");
  capturesPath = join(directory, "captures.jsonl");
});
afterEach(async () => {
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});

describe("routes exist only when captures are enabled", () => {
  it("returns not-found for both capture routes without a captures file, even with the token", async () => {
    await start({ capturesPath: undefined });
    expect((await call(server, { path: "/api/captures", headers: auth() })).status).toBe(404);
    expect((await post(capture())).status).toBe(404);
    const data = await call(server, { path: "/api/data", headers: auth() });
    expect(data.status).toBe(200);
    expect(JSON.parse(data.body).features).toEqual({ captures: false });
  });

  it("serves them when enabled", async () => {
    await start();
    expect((await call(server, { path: "/api/captures", headers: auth() })).status).toBe(200);
    expect((await post(capture())).status).toBe(200);
    const data = await call(server, { path: "/api/data", headers: auth() });
    expect(JSON.parse(data.body).features).toEqual({ captures: true });
  });
});

describe("the same protections as every other route", () => {
  it("requires the exact token, in a header", async () => {
    await start();
    const wrongHeaders: Record<string, string>[] = [{}, { Authorization: "Bearer wrong" }, { Authorization: server.token }];
    for (const headers of wrongHeaders) {
      expect((await call(server, { path: "/api/captures", headers })).status).toBe(401);
      expect((await post(capture(), { Authorization: "Bearer wrong" })).status).toBe(401);
    }
    expect((await call(server, { path: `/api/captures?token=${server.token}` })).status).toBe(401);
    await expect(stat(capturesPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a foreign Host, a foreign or missing Origin on a save, and a wrong content type", async () => {
    await start();
    expect((await call(server, { path: "/api/captures", headers: { ...auth(), Host: "evil.example" } })).status).toBe(403);
    expect((await post(capture(), { Origin: "http://evil.example" })).status).toBe(403);
    const noOrigin = await call(server, {
      method: "POST",
      path: "/api/capture",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify(capture()),
    });
    expect(noOrigin.status).toBe(403);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", ""]) {
      expect((await post(capture(), { "Content-Type": type })).status, type).toBe(415);
    }
    await expect(stat(capturesPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows only GET for the queue and only POST for a save", async () => {
    await start();
    expect((await call(server, { method: "POST", path: "/api/captures", headers: auth() })).status).toBe(405);
    expect((await call(server, { path: "/api/capture", headers: auth() })).status).toBe(405);
    for (const method of ["PUT", "DELETE", "PATCH", "HEAD"]) {
      expect((await call(server, { method, path: "/api/capture", headers: auth() })).status, method).toBe(405);
    }
  });

  it("sends the security headers on every capture response, successes and failures", async () => {
    await start();
    const replies = [
      await call(server, { path: "/api/captures", headers: auth() }),
      await call(server, { path: "/api/captures" }),
      await post(capture()),
      await post(capture({ creatorKey: "creator-z" })),
      await post("{not json"),
    ];
    for (const reply of replies) {
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["referrer-policy"]).toBe("no-referrer");
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(String(reply.headers["content-security-policy"])).toContain("default-src 'none'");
    }
  });
});

describe("body limits", () => {
  it("keeps the 4 KiB cap on decisions while a capture may be about a megabyte", async () => {
    await start();
    const big = JSON.stringify({ creatorKey: "creator-a", videoId: vid(1), decision: "include", reason: "x".repeat(MAX_BODY_BYTES) });
    expect((await post(big, {}, "/api/decision")).status).toBe(413);
    const transcript = "word ".repeat(100_000);
    expect(Buffer.byteLength(transcript)).toBeGreaterThan(MAX_BODY_BYTES * 100);
    expect((await post(capture({ text: transcript }))).status).toBe(200);
  });

  it("accepts the largest legal transcript even when every line break doubles in JSON", async () => {
    await start();
    const worst = "\n".repeat(MAX_TRANSCRIPT_BYTES - 1) + "a";
    const body = JSON.stringify(capture({ text: worst }));
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_TRANSCRIPT_BYTES * 1.9);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_CAPTURE_BODY_BYTES);
    const reply = await post(body);
    expect(reply.status).toBe(200);
    const [event] = parseCaptureLog(await readFile(capturesPath, "utf8"));
    expect(event.text).toBe(worst);
  });

  it("refuses a body over the capture limit, whether declared or streamed, and a transcript over its own limit", async () => {
    await start();
    const huge = JSON.stringify(capture({ text: "x".repeat(MAX_CAPTURE_BODY_BYTES) }));
    expect((await post(huge)).status).toBe(413);
    const streamed = await new Promise<Reply>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          method: "POST",
          path: "/api/capture",
          headers: { Host: `127.0.0.1:${server.port}`, ...auth(), Origin: `http://127.0.0.1:${server.port}`, "Content-Type": "application/json" },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
        }
      );
      outgoing.on("error", reject);
      outgoing.write(huge);
      outgoing.end();
    });
    expect(streamed.status).toBe(413);
    const over = await post(capture({ text: "x".repeat(MAX_TRANSCRIPT_BYTES + 1) }));
    expect(over.status).toBe(400);
    expect(JSON.parse(over.body)).toEqual({ error: "transcript-too-large" });
    await expect(stat(capturesPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("saving a capture", () => {
  it("saves it, returns a receipt without the transcript, and returns the updated queue", async () => {
    await start();
    const reply = await post(capture({ note: "auto captions", captionKind: "auto-generated" }));
    expect(reply.status).toBe(200);
    // The queue carries a 160-character preview, never the transcript.
    expect(reply.body).not.toContain(TEXT);
    const { receipt, queue: state } = JSON.parse(reply.body);
    expect(JSON.stringify(receipt)).not.toContain(SENTINEL);
    expect(receipt).toMatchObject({ creatorKey: "creator-a", videoId: vid(1), event: "captured", capturedAt: NOW.toISOString(), characters: TEXT.length });
    expect(receipt.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(Object.keys(receipt).sort()).toEqual(["capturedAt", "characters", "creatorKey", "event", "hash", "videoId"]);
    const creator = state.creators[0];
    expect(creator.counts).toMatchObject({ captured: 1, needsCapture: 1 });
    expect(creator.items.find((item: { videoId: string }) => item.videoId === vid(1))).toMatchObject({ state: "captured", capture: { captionKind: "auto-generated", note: "auto captions" } });
    const [event] = parseCaptureLog(await readFile(capturesPath, "utf8"));
    expect(event).toMatchObject({ text: TEXT, source: "manual-owner-paste", usageStatus: "internal-research-only" });
    expect((await stat(capturesPath)).mode & 0o777).toBe(0o600);
  });

  it("records an unavailable video and a replacement with its reason", async () => {
    await start();
    expect((await post(capture({ videoId: vid(4), action: "unavailable", text: undefined, publishedDate: undefined, reason: "captions off" }))).status).toBe(200);
    expect((await post(capture())).status).toBe(200);
    const replaced = await post(capture({ action: "replace", reason: "pasted the wrong one", text: TEXT + "tail\n" }));
    expect(replaced.status).toBe(200);
    const events = parseCaptureLog(await readFile(capturesPath, "utf8"));
    expect(events.map((event) => event.event)).toEqual(["unavailable", "captured", "replaced"]);
    expect(events[2].reason).toBe("pasted the wrong one");
  });

  it("returns the queue for the scope the page is showing", async () => {
    await start();
    const wide = JSON.parse((await post(capture({ scope: "included-and-flagged" }))).body).queue;
    expect(wide.scope).toBe("included-and-flagged");
    expect(wide.creators[0].items.map((item: { videoId: string }) => item.videoId)).toEqual([vid(2), vid(1), vid(4)]);
    const narrow = JSON.parse((await post(capture({ videoId: vid(4) }))).body).queue;
    expect(narrow.scope).toBe("included");
  });

  it("does not lose captures when many requests overlap", async () => {
    const many = discoveryFor(Array.from({ length: 20 }, (_, index) => record(index + 1, { title: "NFL Week 6 Player Props" })));
    await start({ discovery: many });
    const replies = await Promise.all(Array.from({ length: 20 }, (_, index) => post(capture({ videoId: vid(index + 1) }))));
    expect(replies.map((reply) => reply.status)).toEqual(Array(20).fill(200));
    expect(parseCaptureLog(await readFile(capturesPath, "utf8"))).toHaveLength(20);
  });

  it("lets exactly one of two racing captures of the same video win", async () => {
    await start();
    const replies = await Promise.all([post(capture()), post(capture())]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(JSON.parse(replies.find((reply) => reply.status === 409)!.body)).toEqual({ error: "already-captured" });
  });
});

describe("refusals", () => {
  it("refuses malformed bodies with one fixed code", async () => {
    await start();
    const bad = [
      "{not json",
      "[]",
      "null",
      JSON.stringify({ ...capture(), extra: 1 }),
      JSON.stringify({ ...capture(), creatorKey: 5 }),
      JSON.stringify({ ...capture(), text: 5 }),
      JSON.stringify({ ...capture(), confirmShort: "yes" }),
      JSON.stringify({ ...capture(), scope: "everything" }),
      JSON.stringify({ creatorKey: "creator-a" }),
    ];
    for (const body of bad) {
      const reply = await post(body);
      expect(reply.status, body.slice(0, 40)).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({ error: "invalid-request" });
    }
    await expect(stat(capturesPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps each problem to a status and a fixed code and never echoes the transcript", async () => {
    await start();
    await post(capture());
    const cases: [Record<string, unknown>, number, string][] = [
      [capture({ creatorKey: "creator-z" }), 400, "unknown-creator-key"],
      [capture({ videoId: vid(55) }), 400, "unknown-video"],
      [capture({ videoId: vid(2), text: "" }), 400, "transcript-empty"],
      [capture({ videoId: vid(2), text: TEXT + "\u0000" }), 400, "transcript-invalid-characters"],
      [capture({ videoId: vid(2), text: "short" }), 400, "transcript-too-short"],
      [capture({ videoId: vid(2), publishedDate: "2025-02-30" }), 400, "invalid-published-date"],
      [capture({ videoId: vid(2), captionKind: "human" }), 400, "invalid-caption-kind"],
      [capture({ videoId: vid(2), action: "delete" }), 400, "invalid-capture-action"],
      [capture({ videoId: vid(2), action: "replace" }), 400, "reason-required"],
      [capture({ videoId: vid(2), note: "n".repeat(501) }), 400, "note-too-long"],
      [capture(), 409, "already-captured"],
      [capture({ videoId: vid(2), action: "replace", reason: "fix" }), 409, "nothing-to-replace"],
    ];
    for (const [body, status, code] of cases) {
      const reply = await post(body);
      expect(reply.status, code).toBe(status);
      expect(JSON.parse(reply.body)).toEqual({ error: code });
      expect(reply.body).not.toContain(SENTINEL);
    }
  });

  it("blocks saves on stale discovery data and withholds the video list", async () => {
    const stale = discoveryFor([record(1, { title: "NFL Week 6 Player Props", apiFetchedAt: "2026-08-01T00:00:00.000Z" })]);
    await start({ discovery: stale });
    const reply = await post(capture());
    expect(reply.status).toBe(409);
    expect(JSON.parse(reply.body)).toEqual({ error: "stale-discovery-data" });
    const state = await queue();
    expect(state.stale.blocked).toBe(true);
    expect(state.creators[0].items).toEqual([]);
    expect(JSON.stringify(state)).not.toContain("Player Props");
  });

  it("reports a damaged log with a fixed code and leaves it untouched", async () => {
    await writeFile(capturesPath, "{ not a capture\n");
    await start();
    for (const reply of [await post(capture()), await call(server, { path: "/api/captures", headers: auth() })]) {
      expect(reply.status).toBe(409);
      expect(JSON.parse(reply.body)).toEqual({ error: "invalid-captures-file" });
      expect(reply.body).not.toContain(directory);
    }
    expect(await readFile(capturesPath, "utf8")).toBe("{ not a capture\n");
  });

  it("reports a held lock as busy and loses nothing", async () => {
    await start({ lock: { timeoutMs: 100 } });
    await post(capture());
    await writeFile(join(directory, ".captures.jsonl.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const slow = await post(capture({ videoId: vid(4) }));
    expect(slow.status).toBe(503);
    expect(JSON.parse(slow.body)).toEqual({ error: "file-busy" });
    expect(parseCaptureLog(await readFile(capturesPath, "utf8"))).toHaveLength(1);
  });
});

describe("the queue endpoint", () => {
  it("returns only included videos by default and adds flagged ones on request", async () => {
    await start();
    const ids = (state: Awaited<ReturnType<typeof queue>>) => state.creators[0].items.map((item: { videoId: string }) => item.videoId);
    expect(ids(await queue())).toEqual([vid(1), vid(4)]);
    expect(ids(await queue("?scope=included"))).toEqual([vid(1), vid(4)]);
    expect(ids(await queue("?scope=included-and-flagged"))).toEqual([vid(2), vid(1), vid(4)]);
    const bad = await call(server, { path: "/api/captures?scope=everything", headers: auth() });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({ error: "invalid-request" });
  });

  it("follows review decisions made through the decision route", async () => {
    await start();
    const decide = await post({ creatorKey: "creator-a", videoId: vid(2), decision: "include", reason: "props throughout" }, {}, "/api/decision");
    expect(decide.status).toBe(200);
    expect((await queue()).creators[0].items.map((item: { videoId: string }) => item.videoId)).toEqual([vid(2), vid(1), vid(4)]);
  });

  it("never sends a transcript, only a preview, however it is asked", async () => {
    await start();
    await post(capture());
    for (const query of ["", "?scope=included-and-flagged"]) {
      const reply = await call(server, { path: `/api/captures${query}`, headers: auth() });
      expect(reply.body).not.toContain(TEXT);
      expect(reply.body.split(SENTINEL).length - 1).toBeLessThanOrEqual(8);
    }
  });
});
