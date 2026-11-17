import "server-only";

import { createPrivateKey } from "node:crypto";
import type { App, ServiceAccount } from "firebase-admin/app";
import { publicConfig } from "./config.client";

type ErrorCode = "missing" | "invalid" | "environment-policy" | "firebase-project-mismatch" | "initialization-failed";

export class ConfigurationError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(`Application configuration unavailable (${code}).`);
    this.name = "ConfigurationError";
    this.code = code;
  }
}

class SanitizedDependencyError extends Error {
  declare code?: string;
  declare status?: number;
}

const applicationStack = (error: Error): string | undefined => {
  // Strip the whole header, including multiline messages, before inspecting
  // frames. Function names are omitted because they can contain supplied text.
  const header = `${error.name}${error.message ? `: ${error.message}` : ""}`;
  if (!error.stack?.startsWith(`${header}\n`)) return undefined;
  const frames = error.stack.slice(header.length + 1).split("\n");
  const location = (frame: string) => frame.match(
    /(?:^|[/\\])(apps\/web\/src\/[\w./\[\]@()-]+|packages\/(?:domain\/src|db\/runtime)\/[\w./\[\]@()-]+):([0-9]+):([0-9]+)\)?$/
  );
  // A dependency stack may contain our callers; only an app-origin error gets
  // a stack. Unknown/compiled chunk origins are omitted rather than inferred.
  if (!location(frames[0] ?? "")) return undefined;
  const locations = frames.map(location).filter(match => match !== null);
  return locations.map(match => `    at ${match[1]}:${match[2]}:${match[3]}`).join("\n");
};

// Keep only diagnostic fields with a bounded vocabulary/format. The incoming
// message, cause, arbitrary name and other SDK/configuration fields never leave.
export const sanitizedFailure = (error: unknown): Error => {
  if (error instanceof ConfigurationError) return new ConfigurationError(error.code);
  if (error instanceof SanitizedDependencyError) return error;
  const safe = new SanitizedDependencyError("Application dependency unavailable.");
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const className = error instanceof Error ? Object.getPrototypeOf(error)?.constructor?.name : undefined;
  safe.name = typeof className === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(className) ? className : "Error";
  if (typeof fields.code === "string" && fields.code.match(/^(?:[0-9A-Z]{5}|[a-z-]+\/[a-z0-9-]+)$/)?.[0] === fields.code) safe.code = fields.code;
  const status = fields.status ?? fields.statusCode;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) safe.status = status;
  safe.stack = error instanceof Error ? applicationStack(error) : undefined;
  return safe;
};

const refuse = (code: ErrorCode): never => { throw new ConfigurationError(code); };
const optionalText = (value: string | undefined) => value?.trim() || undefined;
const requiredText = (value: string | undefined) => optionalText(value) ?? refuse("missing");
const token = (value: string | undefined) => {
  const text = requiredText(value);
  if (/\s/.test(text)) refuse("invalid");
  return text;
};
const enumeration = <const T extends string>(values: readonly T[]) => (raw: string | undefined): T | undefined => {
  const value = optionalText(raw);
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) refuse("invalid");
  return value as T;
};
const integer = (fallback: number, minimum: number, maximum: number) => (raw: string | undefined) => {
  const text = optionalText(raw);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < minimum || value > maximum) refuse("invalid");
  return value;
};

const databaseUrl = (raw: string | undefined) => {
  const value = optionalText(raw);
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
      !url.username || !url.password || !url.pathname.slice(1) || url.pathname.slice(1).includes("/") || url.hash) refuse("invalid");
  // Decode locally to reject invalid percent escapes, without querying a target.
  for (const part of [url.username, url.password, url.pathname.slice(1)]) decodeURIComponent(part);
  return value;
};

const serviceAccount = (raw: string | undefined): Readonly<ServiceAccount> => {
  const encoded = requiredText(raw);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) refuse("invalid");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) refuse("invalid");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) refuse("invalid");
  const account = parsed as Record<string, unknown>;
  if (account.type !== "service_account" || typeof account.project_id !== "string" ||
      typeof account.client_email !== "string" || typeof account.private_key !== "string") refuse("invalid");
  const projectId = requiredText(account.project_id as string);
  const clientEmail = requiredText(account.client_email as string);
  const privateKey = requiredText(account.private_key as string);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) refuse("invalid");
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "rsa") refuse("invalid");
  return Object.freeze({ projectId, clientEmail, privateKey });
};

const inputDefinition = <T>(classification: "secret" | "ordinary configuration" | "sensitive identifier", capabilities: readonly string[], parse: (value: string | undefined) => T) => ({
  classification, capabilities, parse,
  environments: ["production", "preview", "local", "test"] as const,
});

// Executable, value-free definitions: inspecting these does not read inputs.
export const serverInputDefinitions = {
  VERCEL: inputDefinition("ordinary configuration", ["environment"], optionalText),
  VERCEL_ENV: inputDefinition("ordinary configuration", ["environment"], enumeration(["production", "preview", "development"])),
  ODDS_DATA_SOURCE: inputDefinition("ordinary configuration", ["odds"], enumeration(["live", "fixture"])),
  ODDS_API_KEY: inputDefinition("secret", ["live-odds"], token),
  DATABASE_URL: inputDefinition("secret", ["database", "database-presence"], databaseUrl),
  FIREBASE_SERVICE_ACCOUNT_KEY_BASE64: inputDefinition("secret", ["firebase-admin"], serviceAccount),
  ADMIN_UID: inputDefinition("sensitive identifier", ["admin-auth"], token),
  CRON_SECRET: inputDefinition("secret", ["cron-auth"], token),
  ODDS_HEALTH_SECRET: inputDefinition("secret", ["odds-health-auth"], token),
  DB_READINESS_SECRET: inputDefinition("secret", ["database-health-auth"], token),
  ODDS_COLLECTION_PROFILE: inputDefinition("ordinary configuration", ["collector", "collector-health"], enumeration(["disabled", "free-pilot", "paid-baseline"])),
  ODDS_FREE_PILOT_EVENT_ID: inputDefinition("sensitive identifier", ["collector"], optionalText),
  ODDS_COLLECTION_EVENING_HOUR_ET: inputDefinition("ordinary configuration", ["collector"], integer(20, 0, 23)),
  ODDS_COLLECTION_LEASE_MS: inputDefinition("ordinary configuration", ["collector"], integer(45_000, 5_000, 55_000)),
  ODDS_COLLECTION_CLAIM_LIMIT: inputDefinition("ordinary configuration", ["collector"], integer(2, 1, 10)),
  ODDS_COLLECTION_REQUEST_TIMEOUT_MS: inputDefinition("ordinary configuration", ["collector"], integer(15_000, 1_000, 20_000)),
  ODDS_COLLECTION_RETRY_DELAY_MS: inputDefinition("ordinary configuration", ["collector"], integer(60_000, 1_000, 300_000)),
  ODDS_COLLECTION_QUOTA_RESERVE: inputDefinition("ordinary configuration", ["collector", "collector-health"], integer(100, 0, 1_000_000)),
  ODDS_PRIORITY_FAR_INTERVAL_MS: inputDefinition("ordinary configuration", ["collector"], integer(3_600_000, 60_000, 86_400_000)),
  ODDS_PRIORITY_ACTIVE_INTERVAL_MS: inputDefinition("ordinary configuration", ["collector"], integer(300_000, 60_000, 21_600_000)),
};

export type ServerInputName = keyof typeof serverInputDefinitions;
type InputValue<K extends ServerInputName> = ReturnType<(typeof serverInputDefinitions)[K]["parse"]>;
type Result<T> = { value: T } | { error: ConfigurationError };

// Success and failure use the same cache. Do not retain parser/SDK exceptions:
// their messages/causes can contain supplied values and decoded credentials.
const memo = <T>(cache: Map<string, Result<unknown>>, name: string, parse: () => T): T => {
  if (!cache.has(name)) {
    try { cache.set(name, { value: parse() }); }
    catch (error) { cache.set(name, { error: error instanceof ConfigurationError ? error : new ConfigurationError("invalid") }); }
  }
  const result = cache.get(name)!;
  if ("error" in result) throw result.error;
  return result.value as T;
};

export const createServerConfig = (
  read: (name: ServerInputName) => string | undefined = name => process.env[name],
  publicConfiguration: Pick<typeof publicConfig, "firebaseProjectId"> = publicConfig
) => {
  const inputs = new Map<string, Result<unknown>>();
  const capabilities = new Map<string, Result<unknown>>();
  const input = <K extends ServerInputName>(name: K): InputValue<K> =>
    memo(inputs, name, () => serverInputDefinitions[name].parse(read(name))) as InputValue<K>;
  const capability = <T>(name: string, parse: () => T) => memo(capabilities, name, parse);
  const environment = () => capability("environment", () => {
    const hosted = input("VERCEL");
    const target = input("VERCEL_ENV");
    if (hosted && !target) refuse("environment-policy");
    return target === "production" || target === "preview" ? target : "local";
  });
  const odds = () => capability("odds", () => {
    const target = environment();
    const source = input("ODDS_DATA_SOURCE") ?? (target === "production" ? "live" : "fixture");
    if ((target === "production" && source === "fixture") || (target === "preview" && source === "live")) refuse("environment-policy");
    return source === "fixture" ? Object.freeze({ source } as const) : Object.freeze({ source, apiKey: input("ODDS_API_KEY") } as const);
  });
  const liveOdds = () => capability("live-odds", () => {
    const configuration = odds();
    if (configuration.source !== "live") return refuse("environment-policy");
    return configuration;
  });
  const checkFirebaseProject = (account: Readonly<ServiceAccount>) => {
    const project = publicConfiguration.firebaseProjectId();
    if (!project) refuse("missing");
    if (account.projectId !== project) refuse("firebase-project-mismatch");
  };
  const firebase = () => capability("firebase-admin", () => {
    environment();
    const account = input("FIREBASE_SERVICE_ACCOUNT_KEY_BASE64");
    checkFirebaseProject(account);
    return account;
  });
  const required = <K extends ServerInputName>(name: K) => capability(name, () => {
    environment();
    return input(name) ?? refuse("missing");
  });

  return Object.freeze({
    environment, odds, liveOdds, firebase,
    database: () => required("DATABASE_URL"),
    databaseConfigured: () => { environment(); return input("DATABASE_URL") !== undefined; },
    adminUid: () => required("ADMIN_UID"),
    cronSecret: () => required("CRON_SECRET"),
    oddsHealthSecret: () => required("ODDS_HEALTH_SECRET"),
    dbReadinessSecret: () => required("DB_READINESS_SECRET"),
    firebaseApp: (initialize: (account: Readonly<ServiceAccount>) => App): App => {
      const account = firebase();
      // Check before both initialization and reuse; parsing stays memoized.
      checkFirebaseProject(account);
      return capability("firebase-app", () => {
        try { return initialize(account); }
        catch (error) {
          if (error instanceof ConfigurationError) throw error;
          return refuse("initialization-failed");
        }
      });
    },
    collectorHealth: () => capability("collector-health", () => {
      liveOdds();
      return Object.freeze({
        profile: input("ODDS_COLLECTION_PROFILE") ?? "disabled",
        quotaReserve: input("ODDS_COLLECTION_QUOTA_RESERVE"),
      });
    }),
    collector: () => capability("collector", () => {
      liveOdds();
      return Object.freeze({
        profile: input("ODDS_COLLECTION_PROFILE") ?? "disabled",
        freePilotEventId: input("ODDS_FREE_PILOT_EVENT_ID"),
        eveningHourEastern: input("ODDS_COLLECTION_EVENING_HOUR_ET"),
        leaseMs: input("ODDS_COLLECTION_LEASE_MS"),
        claimLimit: input("ODDS_COLLECTION_CLAIM_LIMIT"),
        requestTimeoutMs: input("ODDS_COLLECTION_REQUEST_TIMEOUT_MS"),
        retryDelayMs: input("ODDS_COLLECTION_RETRY_DELAY_MS"),
        quotaReserve: input("ODDS_COLLECTION_QUOTA_RESERVE"),
        priorityFarIntervalMs: input("ODDS_PRIORITY_FAR_INTERVAL_MS"),
        priorityActiveIntervalMs: input("ODDS_PRIORITY_ACTIVE_INTERVAL_MS"),
      });
    }),
  });
};

export const serverConfig = createServerConfig();
