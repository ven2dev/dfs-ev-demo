// @vitest-environment node
import { request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, startReviewServer, type ReviewServer } from "./reviewServer.ts";
import { NOW, discoveryFor, record, vid } from "./testSupport.ts";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// node:http, not fetch: fetch forbids setting Host and Origin, which are
// exactly the headers these tests must control.
const call = (
  server: ReviewServer,
  { method = "GET", path = "/", headers = {}, body }: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
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

let directory: string;
let decisionsPath: string;
let server: ReviewServer;
const TITLE = "SENTINEL-TITLE-NFL-Week-6-best-bets";
const discovery = () => discoveryFor([record(1, { title: TITLE }), record(2), record(3, { publishedAt: "2025-02-01T12:00:00Z" })]);

const start = async (overrides: Partial<Parameters<typeof startReviewServer>[0]> = {}) => {
  server = await startReviewServer({ discovery: discovery(), decisionsPath, now: () => NOW, ...overrides });
  return server;
};
const auth = () => ({ Authorization: `Bearer ${server.token}` });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  call(server, {
    method: "POST",
    path: "/api/decision",
    headers: {
      ...auth(),
      Origin: `http://127.0.0.1:${server.port}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const decision = (overrides: Record<string, unknown> = {}) => ({
  creatorKey: "creator-a",
  videoId: vid(1),
  decision: "include",
  reason: "props throughout",
  ...overrides,
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "creator-corpus-review-"));
  decisionsPath = join(directory, "decisions.json");
});
afterEach(async () => {
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});

describe("binding and addressing", () => {
  it("listens on the loopback address only and prints a fragment-token URL", async () => {
    await start();
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/#token=${server.token}`);
    expect(server.url).not.toContain("?");
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is bound to the loopback address, not to every interface", async () => {
    await start();
    expect(server.address).toBe("127.0.0.1");
  });

  // The real proof: a connection through this machine's own network address
  // must be refused. Skipped only on a machine with no non-loopback IPv4.
  const external = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
  it.skipIf(!external)("refuses connections made through the machine's network address", async () => {
    await start();
    const attempt = new Promise<string>((resolve) => {
      const outgoing = httpRequest({ host: external, port: server.port, path: "/" }, () => resolve("connected"));
      outgoing.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
      outgoing.end();
    });
    expect(await attempt).toBe("ECONNREFUSED");
  });

  it("generates a different token for every server", async () => {
    const first = await start();
    const firstToken = first.token;
    await first.close();
    const second = await start();
    expect(second.token).not.toBe(firstToken);
  });

  it("rejects every Host header except the exact loopback address and port", async () => {
    await start();
    for (const host of ["evil.example", `evil.example:${server.port}`, `localhost:${server.port}`, `127.0.0.1:${server.port + 1}`, "127.0.0.1", `0.0.0.0:${server.port}`]) {
      const reply = await call(server, { headers: { Host: host } });
      expect(reply.status, host).toBe(403);
      expect(JSON.parse(reply.body)).toEqual({ error: "forbidden" });
      expect((await call(server, { path: "/api/data", headers: { Host: host, ...auth() } })).status, host).toBe(403);
    }
    expect((await call(server, {})).status).toBe(200);
  });

  it("stops listening when closed", async () => {
    await start();
    await server.close();
    await expect(call(server, {})).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("assets", () => {
  it("serves the page and its script and style without a token, and none of them carry data", async () => {
    await start();
    for (const [path, type] of [["/", "text/html"], ["/client.js", "text/javascript"], ["/app.css", "text/css"]] as const) {
      const reply = await call(server, { path });
      expect(reply.status).toBe(200);
      expect(reply.headers["content-type"]).toContain(type);
      expect(reply.body).not.toContain(TITLE);
      expect(reply.body).not.toContain(server.token);
    }
  });

  it("loads the page's own script and style only, with no inline code or external reference", async () => {
    await start();
    const html = (await call(server, {})).body;
    expect(html).toContain('src="/client.js"');
    expect(html).toContain('href="/app.css"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/style\s*=/i);
  });
});

describe("security headers", () => {
  it("are present on successes and on every kind of failure", async () => {
    await start();
    const replies = [
      await call(server, {}),
      await call(server, { path: "/api/data", headers: auth() }),
      await call(server, { path: "/api/data" }),
      await call(server, { path: "/missing" }),
      await call(server, { method: "PUT", path: "/api/data" }),
      await call(server, { headers: { Host: "evil.example" } }),
      await post(decision({ creatorKey: "creator-z" })),
    ];
    for (const reply of replies) {
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["referrer-policy"]).toBe("no-referrer");
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(reply.headers["x-frame-options"]).toBe("DENY");
      const csp = String(reply.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
    }
  });
});

describe("token enforcement", () => {
  it("requires the exact token on data and mutation requests", async () => {
    await start();
    const wrong = { Authorization: "Bearer " + "x".repeat(43) };
    for (const headers of [{}, wrong, { Authorization: "Bearer" }, { Authorization: server.token }, { Authorization: `Basic ${server.token}` }, { Authorization: `Bearer ${server.token}x` }, { Authorization: `Bearer ${server.token.slice(1)}` }]) {
      const reply = await call(server, { path: "/api/data", headers });
      expect(reply.status, JSON.stringify(headers)).toBe(401);
      expect(JSON.parse(reply.body)).toEqual({ error: "unauthorized" });
    }
    expect((await post(decision(), { Authorization: wrong.Authorization })).status).toBe(401);
    expect((await call(server, { path: "/api/data", headers: auth() })).status).toBe(200);
    await expect(stat(decisionsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not accept the token in the query string", async () => {
    await start();
    expect((await call(server, { path: `/api/data?token=${server.token}` })).status).toBe(401);
    expect((await call(server, { path: `/api/data?token=${server.token}`, headers: auth() })).status).toBe(200);
  });
});

describe("request validation", () => {
  it("allows only GET for the page and data and only POST for decisions", async () => {
    await start();
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "TRACE"]) {
      expect((await call(server, { method, path: "/api/data", headers: auth() })).status, method).toBe(405);
      expect((await call(server, { method, path: "/" })).status, method).toBe(405);
    }
    expect((await call(server, { method: "POST", path: "/api/data", headers: auth() })).status).toBe(405);
    expect((await call(server, { path: "/api/decision", headers: auth() })).status).toBe(405);
    expect((await call(server, { method: "POST", path: "/" })).status).toBe(405);
    expect((await call(server, { path: "/missing" })).status).toBe(404);
    expect((await call(server, { path: "/../../etc/passwd" })).status).toBe(404);
  });

  it("refuses a foreign Origin on any request and a missing or foreign Origin on a change", async () => {
    await start();
    expect((await call(server, { path: "/api/data", headers: { ...auth(), Origin: "http://evil.example" } })).status).toBe(403);
    expect((await call(server, { headers: { Origin: "https://127.0.0.1" } })).status).toBe(403);
    const noOrigin = await call(server, {
      method: "POST",
      path: "/api/decision",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify(decision()),
    });
    expect(noOrigin.status).toBe(403);
    expect((await post(decision(), { Origin: "http://evil.example" })).status).toBe(403);
    expect((await post(decision(), { Origin: `http://localhost:${server.port}` })).status).toBe(403);
    await expect(stat(decisionsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a JSON content type", async () => {
    await start();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
      expect((await post(decision(), { "Content-Type": type })).status, type).toBe(415);
    }
    expect((await post(decision(), { "Content-Type": "application/json; charset=utf-8" })).status).toBe(200);
  });

  it("refuses an oversized body, whether declared or streamed", async () => {
    await start();
    const big = JSON.stringify(decision({ reason: "x".repeat(MAX_BODY_BYTES) }));
    expect((await post(big)).status).toBe(413);
    const chunked = await new Promise<Reply>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          method: "POST",
          path: "/api/decision",
          headers: { Host: `127.0.0.1:${server.port}`, ...auth(), Origin: `http://127.0.0.1:${server.port}`, "Content-Type": "application/json" },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
        }
      );
      outgoing.on("error", reject);
      outgoing.write(big);
      outgoing.end();
    });
    expect(chunked.status).toBe(413);
    await expect(stat(decisionsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses malformed bodies with one fixed code", async () => {
    await start();
    for (const body of ["{not json", "[]", "null", '"text"', JSON.stringify({ ...decision(), extra: 1 }), JSON.stringify({ creatorKey: 5, videoId: vid(1), decision: "include", reason: "r" }), JSON.stringify({ creatorKey: "creator-a" })]) {
      const reply = await post(body);
      expect(reply.status, body).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({ error: "invalid-request" });
    }
  });
});

describe("decisions", () => {
  it("records a decision with the server's rule version and time and returns the recomputed state", async () => {
    await start();
    const reply = await post(decision());
    expect(reply.status).toBe(200);
    const { event, state } = JSON.parse(reply.body);
    expect(event).toEqual({ videoId: vid(1), decision: "include", reason: "props throughout", ruleVersion: "v1", decidedAt: NOW.toISOString() });
    const video = state.creators[0].videos.find((entry: { videoId: string }) => entry.videoId === vid(1));
    expect(video).toMatchObject({ status: "present", decision: { decision: "include" } });
    expect(JSON.parse(await readFile(decisionsPath, "utf8"))["creator-a"]).toEqual([event]);
    expect((await stat(decisionsPath)).mode & 0o777).toBe(0o600);
  });

  it("recomputes the week slot from the same manifest code the command line uses", async () => {
    await start();
    const slotOf = (state: { creators: { slots: { season: number; week: number; status: string }[] }[] }) =>
      state.creators[0].slots.find((slot) => slot.season === 2025 && slot.week === 6)!.status;
    const before = JSON.parse((await call(server, { path: "/api/data", headers: auth() })).body);
    expect(slotOf(before)).toBe("needs-review");
    const after = JSON.parse((await post(decision())).body).state;
    expect(slotOf(after)).toBe("present");
    const cleared = JSON.parse((await post(decision({ decision: "clear", reason: "unsure" }))).body).state;
    expect(slotOf(cleared)).toBe("needs-review");
  });

  it("maps validation problems to 400, conflicts to 409, and never reveals anything else", async () => {
    await start();
    const cases: [Record<string, unknown>, number, string][] = [
      [{ creatorKey: "creator-z" }, 400, "unknown-creator-key"],
      [{ videoId: vid(55) }, 400, "unknown-video"],
      [{ videoId: vid(3) }, 400, "video-outside-window"],
      [{ reason: "  " }, 400, "reason-required"],
      [{ reason: "x".repeat(501) }, 400, "reason-too-long"],
      [{ decision: "approve" }, 400, "invalid-decision"],
      [{ decision: "clear" }, 409, "nothing-to-clear"],
    ];
    for (const [overrides, status, code] of cases) {
      const reply = await post(decision(overrides));
      expect(reply.status, code).toBe(status);
      expect(JSON.parse(reply.body)).toEqual({ error: code });
    }
  });

  it("blocks every mutation when the discovery data is stale and says so in the state", async () => {
    const stale = discoveryFor([record(1, { apiFetchedAt: "2026-08-01T00:00:00.000Z" })]);
    await start({ discovery: stale });
    const state = JSON.parse((await call(server, { path: "/api/data", headers: auth() })).body);
    expect(state.stale).toEqual({ blocked: true, staleVideos: 1, maxAgeDays: 30, oldestFetchedAt: "2026-08-01T00:00:00.000Z" });
    const reply = await post(decision());
    expect(reply.status).toBe(409);
    expect(JSON.parse(reply.body)).toEqual({ error: "stale-discovery-data" });
    await expect(stat(decisionsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not lose decisions when many requests overlap", async () => {
    const many = discoveryFor(Array.from({ length: 20 }, (_, index) => record(index + 1)));
    await start({ discovery: many });
    const replies = await Promise.all(Array.from({ length: 20 }, (_, index) => post(decision({ videoId: vid(index + 1) }))));
    expect(replies.map((reply) => reply.status)).toEqual(Array(20).fill(200));
    expect(JSON.parse(await readFile(decisionsPath, "utf8"))["creator-a"]).toHaveLength(20);
  });

  it("reports an unreadable decisions file as a generic server error without leaking details", async () => {
    await writeFile(decisionsPath, "{ corrupt");
    await start();
    for (const reply of [await call(server, { path: "/api/data", headers: auth() }), await post(decision())]) {
      expect(reply.status).toBe(500);
      expect(JSON.parse(reply.body)).toEqual({ error: "server-error" });
      expect(reply.body).not.toContain(directory);
    }
    expect(await readFile(decisionsPath, "utf8")).toBe("{ corrupt");
  });
});

describe("data", () => {
  it("returns videos with plain-language reasons, snippets and each video's own history", async () => {
    await start();
    await post(decision());
    const state = JSON.parse((await call(server, { path: "/api/data", headers: auth() })).body);
    const video = state.creators[0].videos.find((entry: { videoId: string }) => entry.videoId === vid(1));
    expect(video).toMatchObject({
      title: TITLE,
      season: 2025,
      week: 6,
      classification: "needs-review",
      reasons: [{ code: "picks-without-prop-signal", label: expect.stringContaining("never props") }],
      events: [{ decision: "include" }],
    });
    expect(state).toMatchObject({ ruleVersion: "v1", window: { endSeason: 2026, endWeek: 4 }, stale: { blocked: false } });
    expect(state.creators.map((creator: { key: string }) => creator.key)).toEqual(["creator-a", "creator-b"]);
  });
});
