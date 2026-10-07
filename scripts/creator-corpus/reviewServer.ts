import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DecisionKind } from "../../src/lib/creatorDecisions.ts";
import { CommandError } from "./commands.ts";
import { createDecisionStore } from "./decisionStore.ts";
import type { DiscoveryFile } from "./discoveryFile.ts";
import { buildReviewState } from "./reviewState.ts";

// Local review page server. It listens on the loopback address only, so it is
// reachable from this machine and nothing else. Every data and mutation
// request needs a random per-run token, and every request must carry the
// exact Host header (a defence against DNS rebinding) and, for changes, a
// matching Origin. Failures return one fixed code, never a path or message.
export const MAX_BODY_BYTES = 4096;
export const LOOPBACK_ADDRESS = "127.0.0.1";

const ASSETS = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/client.js": { file: "client.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
} as const;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const VALIDATION_CODES = new Set([
  "unknown-creator-key",
  "unknown-video",
  "video-outside-window",
  "reason-required",
  "reason-too-long",
  "invalid-decision",
  "invalid-video-id",
]);
const CONFLICT_CODES = new Set(["stale-discovery-data", "nothing-to-clear"]);

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const tokenMatches = (supplied: string, expected: string): boolean =>
  timingSafeEqual(sha256(supplied), sha256(expected));

const send = (response: ServerResponse, status: number, type: string, body: string): void => {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  response.end(body);
};
const sendJson = (response: ServerResponse, status: number, body: unknown): void =>
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));

// Reads at most `limit` bytes. An oversized body is discarded as it arrives,
// so a large upload cannot use memory, and the request timeout bounds a slow one.
const readBody = (request: IncomingMessage, limit: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on("end", () => (tooLarge ? reject(new HttpError(413, "payload-too-large")) : resolve(Buffer.concat(chunks).toString("utf8"))));
    request.on("error", () => reject(new HttpError(400, "invalid-request")));
  });

const parseDecisionRequest = (body: string): { creatorKey: string; videoId: string; decision: DecisionKind; reason: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, "invalid-request");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "invalid-request");
  const { creatorKey, videoId, decision, reason, ...extra } = parsed as Record<string, unknown>;
  if (
    Object.keys(extra).length > 0 ||
    typeof creatorKey !== "string" ||
    typeof videoId !== "string" ||
    typeof decision !== "string" ||
    typeof reason !== "string"
  ) {
    throw new HttpError(400, "invalid-request");
  }
  return { creatorKey, videoId, decision: decision as DecisionKind, reason };
};

export type ReviewServer = {
  // The address the socket is actually bound to, for verification.
  address: string;
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
};

export const startReviewServer = async ({
  discovery,
  decisionsPath,
  now,
  port = 0,
  token = randomBytes(32).toString("base64url"),
}: {
  discovery: DiscoveryFile;
  decisionsPath: string;
  now: () => Date;
  port?: number;
  token?: string;
}): Promise<ReviewServer> => {
  const store = createDecisionStore({ path: decisionsPath, discovery, now });
  const assets = new Map<string, { body: string; type: string }>();
  for (const [route, { file, type }] of Object.entries(ASSETS)) {
    assets.set(route, { body: await readFile(new URL(`./review/${file}`, import.meta.url), "utf8"), type });
  }

  const state = async () => buildReviewState({ discovery, decisions: await store.read(), now: now() });

  const handle = async (request: IncomingMessage, response: ServerResponse, origin: string, host: string) => {
    if (request.headers.host !== host) throw new HttpError(403, "forbidden");
    if (request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "method-not-allowed");
    const suppliedOrigin = request.headers.origin;
    if (suppliedOrigin !== undefined && suppliedOrigin !== origin) throw new HttpError(403, "forbidden");
    let path: string;
    try {
      path = new URL(request.url ?? "/", origin).pathname;
    } catch {
      throw new HttpError(400, "invalid-request");
    }

    const asset = assets.get(path);
    if (asset) {
      if (request.method !== "GET") throw new HttpError(405, "method-not-allowed");
      return send(response, 200, asset.type, asset.body);
    }
    if (path !== "/api/data" && path !== "/api/decision") throw new HttpError(404, "not-found");
    if ((path === "/api/data") !== (request.method === "GET")) throw new HttpError(405, "method-not-allowed");

    // The page itself carries no data, so it needs no token; everything below does.
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith("Bearer ") || !tokenMatches(authorization.slice(7), token)) {
      throw new HttpError(401, "unauthorized");
    }

    if (path === "/api/data") return sendJson(response, 200, await state());

    if (suppliedOrigin !== origin) throw new HttpError(403, "forbidden");
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "unsupported-media-type");
    }
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, "payload-too-large");
    const event = await store.append(parseDecisionRequest(await readBody(request, MAX_BODY_BYTES)));
    return sendJson(response, 200, { event, state: await state() });
  };

  const server: Server = createServer((request, response) => {
    const address = server.address() as AddressInfo;
    const host = `${LOOPBACK_ADDRESS}:${address.port}`;
    handle(request, response, `http://${host}`, host).catch((error: unknown) => {
      if (response.headersSent) return response.end();
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.code });
      const code = error instanceof CommandError ? error.code : "";
      if (VALIDATION_CODES.has(code)) return sendJson(response, 400, { error: code });
      if (CONFLICT_CODES.has(code)) return sendJson(response, 409, { error: code });
      return sendJson(response, 500, { error: "server-error" });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_ADDRESS, () => resolve());
  });
  const { port: boundPort, address: boundAddress } = server.address() as AddressInfo;
  return {
    address: boundAddress,
    port: boundPort,
    token,
    // The token is in the fragment, which browsers never send to the server,
    // keep out of history and referrers, and the page removes after reading.
    url: `http://${LOOPBACK_ADDRESS}:${boundPort}/#token=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};
