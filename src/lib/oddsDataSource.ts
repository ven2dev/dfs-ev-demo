export const ODDS_DATA_SOURCES = ["live", "fixture"] as const;

export type OddsDataSource = (typeof ODDS_DATA_SOURCES)[number];

type OddsRuntimeEnv = {
  [key: string]: string | undefined;
  VERCEL_ENV?: string;
  ODDS_DATA_SOURCE?: string;
  ODDS_API_KEY?: string;
};

export const isOddsDataSource = (value: unknown): value is OddsDataSource =>
  typeof value === "string" && (ODDS_DATA_SOURCES as readonly string[]).includes(value);

const configuredDataSource = (raw: string | undefined): OddsDataSource | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  if (isOddsDataSource(value)) return value;
  throw new Error(`Unknown ODDS_DATA_SOURCE "${value}"; expected "live" or "fixture"`);
};

const runtimeTarget = (env: OddsRuntimeEnv): "production" | "preview" | "local" => {
  const vercelEnv = env.VERCEL_ENV?.trim();
  if (vercelEnv === "production" || vercelEnv === "preview") return vercelEnv;
  if (vercelEnv === "development" || !vercelEnv) return "local";
  throw new Error(`Unknown VERCEL_ENV "${vercelEnv}"`);
};

export const resolveOddsDataSource = (env: OddsRuntimeEnv = process.env): OddsDataSource => {
  const target = runtimeTarget(env);
  const configured = configuredDataSource(env.ODDS_DATA_SOURCE);

  if (target === "production" && configured === "fixture") {
    throw new Error("Production refuses ODDS_DATA_SOURCE=fixture");
  }
  if (target === "preview" && configured === "live") {
    throw new Error("Preview refuses ODDS_DATA_SOURCE=live");
  }

  // Production keeps its pre-#58 live behavior during rollout. Every other
  // environment defaults to deterministic fixtures so an omitted setting
  // cannot spend provider quota or make Preview depend on Production data.
  const source = configured ?? (target === "production" ? "live" : "fixture");

  // Deliberately read the secret only after fixture mode has returned. This
  // keeps the fixture boundary testable and prevents Preview from depending
  // on the mere presence or absence of a Production Odds API credential.
  if (source === "fixture") return source;
  if (!env.ODDS_API_KEY?.trim()) {
    throw new Error("ODDS_DATA_SOURCE=live requires ODDS_API_KEY");
  }
  return source;
};

export const requireLiveOddsDataSource = (env: OddsRuntimeEnv = process.env) => {
  const source = resolveOddsDataSource(env);
  if (source !== "live") {
    throw new Error("This operation is disabled unless ODDS_DATA_SOURCE=live");
  }
  return source;
};
