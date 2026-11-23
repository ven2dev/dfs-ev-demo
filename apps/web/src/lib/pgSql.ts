import "server-only";

import { TypeOverrides, type Pool, type PoolClient, type QueryConfig, type QueryResult } from "pg";

export type SqlRow = Record<string, unknown>;
// Failure containment, not the 90 ms pre-provider latency target. Reviewed
// together with A2 before adoption by getSql(). Queue and connect share it.
export const PG_ACQUISITION_CEILING_MS = 2_000;
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

// A cancelled checkout can still complete inside pg. Its continuation owns the
// late release; neither a client nor a rejected connect promise is abandoned.
function acquire(pool: Pick<Pool, "connect">, signal?: AbortSignal): Promise<PoolClient> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let waiting = true;
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const refuse = (error: unknown) => {
      if (!waiting) return;
      waiting = false; finish(); reject(error);
    };
    const abort = () => refuse(signal!.reason);
    const timer = setTimeout(() => refuse(new Error("Database acquisition timed out.")), PG_ACQUISITION_CEILING_MS);
    signal?.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => pool.connect()).then(client => {
      if (!waiting) { client.release(); return; }
      waiting = false; finish(); resolve(client);
    }, refuse);
  });
}

function cancelled<T>(run: () => Promise<T>, signal: AbortSignal | undefined, discard: () => void): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return run();
  return new Promise((resolve, reject) => {
    const abort = () => { discard(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    // Install before starting: a transport/test can synchronously abort inside
    // query(). Both late fulfillment and rejection remain observed.
    void Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }).then(value => {
      signal.removeEventListener("abort", abort); resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Isolated adapter; getSql() stays on Neon until checkpoint B. */
export function createPgSql(pool: Pick<Pool, "connect">): Sql {
  // Query-local overrides preserve the installed text-decoding contract and
  // leave the pipeline's global pg parsers untouched.
  const types = new TypeOverrides();
  const execute = async (target: Pick<PoolClient, "query">, config: QueryConfig<unknown[]>) =>
    rows(await target.query<SqlRow>({ ...config, types }));

  return {
    query: async (text, parameters) => {
      const config = queryConfig(text, parameters);
      const client = await acquire(pool);
      let discard = false;
      const onError = () => { discard = true; };
      client.on("error", onError);
      try { return await execute(client, config); }
      catch (error) { discard = true; throw error; }
      finally { client.removeListener("error", onError); client.release(discard); }
    },
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
      const client = await acquire(pool, signal);
      let phase: "checkout" | "begin" | "statements" | "commit" = "checkout";
      let discard = false;
      let released = false;
      const release = (destroy: boolean) => {
        if (released) return;
        released = true; client.release(destroy);
      };
      const onError = () => { discard = true; };
      client.on("error", onError);
      const run = (config: QueryConfig<unknown[]>) => cancelled(() => execute(client, config), signal, () => {
        discard = true; release(true);
      });
      try {
        signal?.throwIfAborted();
        phase = "begin";
        await run({ text: begin });
        phase = "statements";
        const results: SqlRow[][] = [];
        for (const query of queries) {
          signal?.throwIfAborted();
          results.push(await run(query));
        }
        signal?.throwIfAborted();
        phase = "commit";
        await run({ text: "COMMIT" });
        return results;
      } catch (error) {
        // COMMIT failure has an ambiguous outcome. Never replay, and never
        // return that connection as healthy. A2 proves protocol/cancel paths.
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        // Only a server SQL error establishes that this is a recoverable
        // statement failure. Network/client timeouts have uncertain protocol
        // state; queuing ROLLBACK on them is unsafe and may hang.
        discard ||= phase !== "statements" || signal?.aborted === true ||
          typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code) || /^(08|57P0)/.test(code);
        if (!discard) {
          try { await run({ text: "ROLLBACK" }); }
          catch { discard = true; }
        }
        throw error;
      } finally {
        client.removeListener("error", onError);
        release(discard);
      }
    },
  };
}
