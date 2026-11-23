import "server-only";
import { admitPaidOdds, SUBJECT_KEY, type AdmissionQuery, type SubjectDimension } from "@dfs-ev/db/runtime";
import { createPaidOddsStartup } from "./paidOddsStartup";
import { createOddsSubjectResolver, type SubjectReason } from "./oddsSubject";
import { checkInteractiveQuotaFloor, InteractiveQuotaUnavailable } from "./providerQuota";
import { getSql } from "./db";
import { serverConfig } from "./config.server";
import { initializeOddsCache } from "./oddsCacheStartup";
import { parseBearerToken } from "./parseBearerToken";
import type { NextRequest } from "next/server";
import { TRACKABLE_PLAYER_PROP_MARKET_KEYS } from "./playerPropMarkets";

export type SubjectResolver = () => Promise<readonly SubjectDimension[] | null>;
export type PaidRefreshRequest = { resolveSubject: SubjectResolver };
const reasons = ["identity-unavailable", "invalid-token", "subject-configuration-unavailable", "not-installed",
  "capability-unavailable", "limiter-evaluation-failed", "limiter-counter-failed", "limiter-storage-failed", "quota-read-failed"] as const;
type Reason = typeof reasons[number];
const counts: Partial<Record<Reason, number>> = {};
let recent: { reason: Reason; at: number } | null = null;
const record = (reason: Reason) => {
  if (!reasons.includes(reason)) return;
  counts[reason] = Math.min(Number.MAX_SAFE_INTEGER, (counts[reason] ?? 0) + 1);
  if (reason !== "invalid-token" && reason !== "not-installed") recent = { reason, at: performance.now() };
  if (reason === "not-installed") console.info("[paid-odds] not-installed");
  else console.warn(`[paid-odds] ${reason}`);
};

// An advisory bounded negative cache. Only actual enforced denials enter it;
// would-deny retry values on outcome=allow never do. No raw identity or resource.
export const createPaidOddsBoundary = (deps: {
  initialize: () => Promise<"ready" | "not-installed" | "unavailable">;
  query: AdmissionQuery;
  fallbackFloor: () => Promise<void>;
  reserve: () => number;
  enforce: boolean;
  sharedCacheReady: () => Promise<boolean>;
  warn: (reason: Reason) => void;
  now?: () => number;
  maxDeniedSubjects?: number;
}) => {
  const now = deps.now ?? (() => performance.now());
  const maximum = Number.isInteger(deps.maxDeniedSubjects) ? Math.max(1, Math.min(deps.maxDeniedSubjects!, 2048)) : 2048;
  const denied = new Map<string, number>();
  const reportedNull = new WeakSet<SubjectResolver>();
  const hit = (dimensions: readonly SubjectDimension[]) => dimensions.some(d => d.keys.some(key => {
    const until = denied.get(key); if (until === undefined) return false;
    if (until <= now()) { denied.delete(key); return false; }
    return true;
  }));
  const resolve = async (request?: PaidRefreshRequest) => {
    try { return await request?.resolveSubject() ?? null; }
    catch {
      if (request && !reportedNull.has(request.resolveSubject)) {
        deps.warn("identity-unavailable"); reportedNull.add(request.resolveSubject);
      }
      return null;
    }
  };
  const canEnforce = async () => {
    if (!deps.enforce) return false;
    try { return await deps.sharedCacheReady(); } catch { return false; }
  };
  const beforeClaim = async (request?: PaidRefreshRequest) => {
    if (!request || denied.size === 0 || !await canEnforce()) return false;
    const dimensions = await resolve(request);
    return dimensions ? hit(dimensions) : false;
  };
  const check = async (request?: PaidRefreshRequest) => {
    if (await deps.initialize() !== "ready") return deps.fallbackFloor();
    const dimensions = await resolve(request);
    if (!dimensions) {
      if (!request || !reportedNull.has(request.resolveSubject)) {
        deps.warn("identity-unavailable");
        if (request) reportedNull.add(request.resolveSubject);
      }
      return deps.fallbackFloor();
    }
    const enforce = await canEnforce();
    const started = now();
    const result = await admitPaidOdds(deps.query, dimensions,
      { enforce, reserve: deps.reserve(), batch: TRACKABLE_PLAYER_PROP_MARKET_KEYS.length });
    if (result.warning) deps.warn(result.warning);
    if (result.outcome === "subject-rate-limit" && enforce) {
      const until = started + result.retryAfterMs;
      for (const key of result.deniedSubjects) if (SUBJECT_KEY.test(key) && until > now()) {
        denied.delete(key);
        while (denied.size >= maximum) denied.delete(denied.keys().next().value!);
        denied.set(key, until);
      }
      throw new InteractiveQuotaUnavailable("subject-rate-limit");
    }
    if (result.outcome === "quota-floor") throw new InteractiveQuotaUnavailable();
  };
  return { check, beforeClaim, deniedSize: () => denied.size };
};

const configuration = () => {
  try { return serverConfig.paidOdds(); } catch { return null; }
};
const startup = createPaidOddsStartup({
  query: (text, params) => getSql().query(text, params),
  keysConfigured: () => configuration() !== null && serverConfig.databaseConfigured(),
  warn: record,
});
// Enforce is intentionally unavailable in production until #224's
// owner activation. Even a future enforce request downgrades to shadow unless
// #221 capability selected the shared path; legacy coalescing cannot isolate a
// creator's denial from eligible joiners. Factories expose enforce for tests.
const boundary = createPaidOddsBoundary({ initialize: startup.initialize,
  query: (text, params) => getSql().query(text, params), fallbackFloor: () => checkInteractiveQuotaFloor(),
  reserve: () => serverConfig.collectorHealth().quotaReserve, enforce: false, sharedCacheReady: async () => await initializeOddsCache() === "shared", warn: record });
export const initializePaidOdds = startup.initialize;
export const checkPaidOddsAdmission = boundary.check;
export const shouldDenyPaidRefresh = boundary.beforeClaim;
export const paidOddsHealth = () => ({
  capability: startup.status(), mode: "log-only" as const, liveUserAttribution: true,
  reasonCounts: { ...counts }, recentError: recent && performance.now() - recent.at < 900_000 ? recent.reason : null,
  scope: "this-instance" as const,
});
export const createPaidRefreshRequest = (request: NextRequest): PaidRefreshRequest => {
  let resolver: SubjectResolver | undefined;
  let expiresAt = Infinity;
  let expired = false;
  const resolveSubject: SubjectResolver = async () => {
    if (!expired && Date.now() >= expiresAt) {
      expired = true;
      resolver = undefined;
    }
    if (!resolver) {
      const config = configuration();
      if (!config) return Promise.resolve(null);
      resolver = createOddsSubjectResolver({
        headers: request.headers,
        platform: serverConfig.environment() === "local" ? "untrusted" : "vercel", ...config,
        verifiedUid: async () => {
          if (expired) return null;
          const token = parseBearerToken(request);
          if (!token) return null;
          // Attribution is not account authorization. Cached signing keys are
          // sufficient; a revocation lookup would add a network hop per leader.
          // Load Admin only here, never merely by importing the collector path.
          const { getAdminAuth } = await import("./firebaseAdmin");
          const decoded = await getAdminAuth().verifyIdToken(token, false);
          // Only the SDK-verified expiry can bound this request-local memo.
          if (!Number.isFinite(decoded.exp)) return null;
          expiresAt = decoded.exp * 1_000;
          if (Date.now() >= expiresAt) { expired = true; return null; }
          return decoded.uid;
        },
        warn: (reason: SubjectReason) => { if (reason !== "identity-unavailable") record(reason); },
      });
    }
    const selected = resolver;
    const result = await selected();
    // A follower wait or verification can cross exp. Every concurrent waiter
    // rechecks after await, even if another waiter has already invalidated it.
    if ((expired || Date.now() >= expiresAt) && result?.some(d => d.traffic === "signed-in")) {
      expired = true;
      if (resolver === selected) resolver = undefined;
      return resolveSubject();
    }
    return result;
  };
  return { resolveSubject };
};
