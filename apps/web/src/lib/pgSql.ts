import "server-only";

import { TypeOverrides, type Pool, type PoolClient, type QueryConfig, type QueryResult } from "pg";

export type SqlRow = Record<string, unknown>;
declare const statement: unique symbol;
export type TransactionStatement = { readonly [statement]: true };

export interface SqlTransactionOptions {
  readOnly?: boolean;
  isolationLevel?: "RepeatableRead";
  fetchOptions?: { signal?: AbortSignal };
}

export interface SqlTransaction {
  query(text: string, parameters?: unknown[]): TransactionStatement;
}

export interface Sql {
  query(text: string, parameters?: unknown[]): Promise<SqlRow[]>;
  transaction(
    build: (transaction: SqlTransaction) => TransactionStatement[],
    options?: SqlTransactionOptions,
  ): Promise<SqlRow[][]>;
}

function queryConfig(text: string, parameters: unknown[] = []): QueryConfig<unknown[]> {
  // This is an internal SQL API, not a SQL parser. Conservatively refuse the
  // token even in comments/literals rather than introduce persistent names.
  if (typeof text !== "string" || /\bPREPARE\b/i.test(text) || !Array.isArray(parameters)) {
    throw new TypeError("Database query contract is invalid.");
  }
  return { text, values: [...parameters] };
}

function beginStatement(options: SqlTransactionOptions): string {
  if (Object.keys(options).some(key => !["readOnly", "isolationLevel", "fetchOptions"].includes(key)) ||
    (options.readOnly !== undefined && typeof options.readOnly !== "boolean") ||
    (options.isolationLevel !== undefined && options.isolationLevel !== "RepeatableRead") ||
    (options.fetchOptions !== undefined && Object.keys(options.fetchOptions).some(key => key !== "signal"))) {
    throw new TypeError("Database transaction options are invalid.");
  }
  return "BEGIN" + (options.isolationLevel ? " ISOLATION LEVEL REPEATABLE READ" : "") +
    (options.readOnly === undefined ? "" : options.readOnly ? " READ ONLY" : " READ WRITE");
}

function rows(result: QueryResult<SqlRow>): SqlRow[] {
  // Multiple SQL commands can produce pg.Result[]. No current caller needs
  // that broader API; never silently return undefined instead of row arrays.
  if (Array.isArray(result)) throw new TypeError("Database query returned multiple results.");
  return result.rows;
}

/**
 * A1 contract only: the pool is injected and getSql() remains on Neon.
 * A2 supplies bounded ownership, TLS, lifecycle and prompt cancellation;
 * signal checks here preserve the option and prevent further batch work.
 */
export function createPgSql(pool: Pick<Pool, "query" | "connect">): Sql {
  // Query-local overrides preserve the installed text-decoding contract and
  // leave the pipeline's global pg parsers untouched.
  const types = new TypeOverrides();
  const execute = async (target: Pick<PoolClient, "query">, config: QueryConfig<unknown[]>) =>
    rows(await target.query<SqlRow>({ ...config, types }));

  return {
    query: async (text, parameters) => execute(pool, queryConfig(text, parameters)),
    async transaction(build, options = {}) {
      const begin = beginStatement(options);
      const signal = options.fetchOptions?.signal;
      signal?.throwIfAborted();
      const descriptions = new Map<TransactionStatement, QueryConfig<unknown[]>>();
      const batch = build({
        query(text, parameters) {
          const config = queryConfig(text, parameters);
          const token = Object.freeze({}) as TransactionStatement;
          descriptions.set(token, config);
          return token;
        },
      });
      if (!Array.isArray(batch) || batch.some(query => !descriptions.has(query))) {
        throw new TypeError("Database transaction requires its own deferred statements.");
      }
      // Snapshot before the first await; a retained builder array cannot alter
      // the transaction after checkout or smuggle an executing promise into it.
      const queries = batch.map(query => descriptions.get(query)!);
      signal?.throwIfAborted();
      const client = await pool.connect();
      let phase: "checkout" | "begin" | "statements" | "commit" = "checkout";
      let discard = false;
      try {
        signal?.throwIfAborted();
        phase = "begin";
        await execute(client, { text: begin });
        phase = "statements";
        const results: SqlRow[][] = [];
        for (const query of queries) {
          signal?.throwIfAborted();
          results.push(await execute(client, query));
        }
        signal?.throwIfAborted();
        phase = "commit";
        await execute(client, { text: "COMMIT" });
        return results;
      } catch (error) {
        // COMMIT failure has an ambiguous outcome. Never replay, and never
        // return that connection as healthy. A2 proves protocol/cancel paths.
        discard = phase !== "statements" || signal?.aborted === true;
        if (!discard) {
          try { await execute(client, { text: "ROLLBACK" }); }
          catch { discard = true; }
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },
  };
}
