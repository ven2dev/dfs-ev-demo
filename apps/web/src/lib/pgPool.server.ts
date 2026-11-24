import "server-only";

import { Pool, type PoolConfig } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { ConfigurationError, sanitizedFailure, serverConfig } from "./config.server";
import { createPgSql, PG_ACQUISITION_CEILING_MS, type Sql } from "./pgSql";

/** No URL option can override TLS, target, timeout or pool policy. */
export function verifiedPgConfiguration(connectionString: string, maximum: number): PoolConfig {
  try {
    const url = new URL(connectionString);
    const mode = url.searchParams.getAll("sslmode");
    if (!Number.isSafeInteger(maximum) || maximum < 1 ||
      !["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      !url.pathname.slice(1) || decodeURIComponent(url.pathname.slice(1)).includes("/") || url.hash ||
      [...url.searchParams.keys()].some(key => key !== "sslmode") || mode.length > 1 ||
      (mode.length === 1 && !["require", "verify-full"].includes(mode[0]))) throw new ConfigurationError("invalid");
    return {
      host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port ? Number(url.port) : 5432,
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)), ssl: { rejectUnauthorized: true },
      // A truthy whitespace options string suppresses pg's ambient PGOPTIONS
      // fallback without introducing any session setting or setup statement.
      sslnegotiation: "postgres", options: " ", application_name: "dfs-ev-web", client_encoding: "UTF8",
      min: 0, max: maximum, idleTimeoutMillis: 5_000, maxLifetimeSeconds: 60,
      connectionTimeoutMillis: PG_ACQUISITION_CEILING_MS, query_timeout: 15_000,
    };
  } catch { throw new ConfigurationError("invalid"); }
}

/** One independent runtime owner, not a deployment-wide singleton. The final
 * maximum is deliberately required; the cutover plan owns capacity selection. */
export function createPgSqlOwner(options: {
  maximum: number;
  readConnectionString?: () => string;
  createPool?: (config: PoolConfig) => Pool;
  attach?: (pool: Pool) => void;
  onBackgroundError?: (error: Error) => void;
}) {
  let cached: { connectionString: string; pool: Pool; sql: Sql } | undefined;
  let closed = false;
  const report = (error: unknown) => {
    // A logging callback cannot turn an idle event into an unhandled rejection.
    try {
      if (options.onBackgroundError) options.onBackgroundError(sanitizedFailure(error));
      else console.warn("[database] idle connection unavailable.");
    } catch { /* reason already sanitized */ }
  };
  return {
    get(): Sql {
      try {
        if (closed) throw new ConfigurationError("initialization-failed");
        const connectionString = (options.readConnectionString ?? serverConfig.database)();
        if (cached) {
          if (cached.connectionString !== connectionString) throw new ConfigurationError("environment-policy");
          return cached.sql;
        }
        const config = verifiedPgConfiguration(connectionString, options.maximum);
        const pool = (options.createPool ?? (config => new Pool(config)))(config);
        pool.on("error", report);
        try { (options.attach ?? attachDatabasePool)(pool); }
        catch (error) { void pool.end().catch(report); throw error; }
        const raw = createPgSql(pool);
        const sql: Sql = {
          query: (...args) => raw.query(...args).catch(error => { throw sanitizedFailure(error); }),
          transaction: (...args) => raw.transaction(...args).catch(error => { throw sanitizedFailure(error); }),
        };
        cached = { connectionString, pool, sql };
        return sql;
      } catch (error) { throw sanitizedFailure(error); }
    },
    async end() { closed = true; await cached?.pool.end().catch(error => { throw sanitizedFailure(error); }); },
  };
}
