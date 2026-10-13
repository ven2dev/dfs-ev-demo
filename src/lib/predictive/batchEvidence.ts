import type { QueryResultRow } from "pg";
import { canonical, refuse } from "./validation.ts";

// Internal SELECTs only, within one guarded transaction. Never accept SQL from
// a caller. Results use JSON-compatible projections (including explicit UTC
// timestamps), rather than pg's Date/int8 conversion. Bound both server work
// and retained metadata; coalescing round trips alone is not a capacity claim.
export const EVIDENCE_BATCH_BOUNDS = { queries: 4096, perStatement: 16, rows: 131_072, bytes: 20_000_000 } as const;
type Result = { rows: QueryResultRow[] };
type Pending = { sql: string; values: unknown[]; resolve: (value: Result) => void; reject: (error: unknown) => void };
export const createEvidenceBatch = (execute: (sql: string, values: unknown[]) => Promise<Result>) => {
  const cache = new Map<string, Promise<Result>>();
  const work = new Map<string, Promise<unknown>>();
  const pending: Pending[] = [];
  let flushing = false, failure: unknown, rows = 0, bytes = 0, statements = 0;
  const flush = async () => {
    if (flushing) return;
    flushing = true;
    try {
      while (pending.length) {
        const group = pending.splice(0, EVIDENCE_BATCH_BOUNDS.perStatement);
        const values: unknown[] = [];
        const sql = group.map((item, ordinal) => {
          const offset = values.length; values.push(...item.values);
          const shifted = item.sql.replace(/\$(\d+)/g, (_, index: string) => "$" + (Number(index) + offset));
          return `SELECT ${ordinal} AS ordinal,coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) AS rows FROM (${shifted}) e`;
        }).join(" UNION ALL ");
        try {
          statements++;
          const result = await execute(sql, values);
          if (result.rows.length !== group.length) refuse("training-evidence-inventory-mismatch");
          // Validate the entire response before resolving any component.
          const indexed = new Map<number, QueryResultRow[]>();
          for (const item of result.rows) {
            if (!Number.isInteger(item.ordinal) || item.ordinal < 0 || item.ordinal >= group.length ||
                indexed.has(item.ordinal) || !Array.isArray(item.rows)) refuse("training-evidence-inventory-mismatch");
            indexed.set(item.ordinal, item.rows);
            rows += item.rows.length; bytes += Buffer.byteLength(JSON.stringify(item.rows));
          }
          if (rows > EVIDENCE_BATCH_BOUNDS.rows || bytes > EVIDENCE_BATCH_BOUNDS.bytes) refuse("training-evidence-bounds-refused");
          group.forEach((item, ordinal) => item.resolve({ rows: indexed.get(ordinal)! }));
        } catch (error) {
          failure = error; group.forEach((item) => item.reject(error));
        }
        if (failure) { pending.splice(0).forEach((item) => item.reject(failure)); break; }
      }
    } finally { flushing = false; }
  };
  const query = (sql: string, values: unknown[] = []): Promise<Result> => {
    if (failure) return Promise.reject(failure);
    const key = canonical([sql, values]); const existing = cache.get(key);
    if (existing) return existing;
    if (cache.size >= EVIDENCE_BATCH_BOUNDS.queries) return Promise.reject(new Error("training-evidence-bounds-refused"));
    const promise = new Promise<Result>((resolve, reject) => pending.push({ sql, values, resolve, reject }));
    cache.set(key, promise);
    // A macrotask gathers independent verification branches. The pg session
    // still executes just one bounded statement at a time.
    if (!flushing) setImmediate(() => { void flush(); });
    return promise;
  };
  const memo = <T>(namespace: string, key: unknown, verify: () => Promise<T>): Promise<T> => {
    const identity = canonical([namespace, key]);
    let promise = work.get(identity);
    if (!promise) {
      if (work.size >= EVIDENCE_BATCH_BOUNDS.queries) return Promise.reject(new Error("training-evidence-bounds-refused"));
      promise = Promise.resolve().then(verify); work.set(identity, promise);
    }
    return promise as Promise<T>;
  };
  return { query, memo, metrics: () => ({ queries: cache.size, verifications: work.size, statements, rows, bytes }) };
};
