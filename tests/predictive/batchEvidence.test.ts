import { expect, it } from "vitest";
import { createEvidenceBatch, EVIDENCE_BATCH_BOUNDS } from "../../src/lib/predictive/batchEvidence.ts";

it("coalesces distinct parameter sets and shares identical in-flight queries", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const batch = createEvidenceBatch(async (sql, values) => {
    calls.push({ sql, values });
    // Out-of-order response deliberately exercises ordinal routing.
    return { rows: [{ ordinal: 1, rows: [{ n: 2 }] }, { ordinal: 0, rows: [{ n: 1 }] }] };
  });
  const a = batch.query("SELECT $1::integer AS n", [1]);
  expect(batch.query("SELECT $1::integer AS n", [1])).toBe(a);
  expect(await Promise.all([a, batch.query("SELECT $1::integer AS n", [2])])).toEqual([{ rows: [{ n: 1 }] }, { rows: [{ n: 2 }] }]);
  expect(calls).toHaveLength(1);
  expect(calls[0].values).toEqual([1, 2]);
  expect(calls[0].sql).toContain("SELECT $2::integer AS n");
  expect(batch.metrics()).toMatchObject({ queries: 2, statements: 1, rows: 2 });
});

it("shares verification promises only within the batch and preserves failures", async () => {
  const a = createEvidenceBatch(async () => ({ rows: [] }));
  const b = createEvidenceBatch(async () => ({ rows: [] }));
  let calls = 0;
  const verify = async () => { calls++; throw new Error("damaged-shared-file"); };
  const one = a.memo("file", ["address", 42], verify);
  expect(a.memo("file", ["address", 42], verify)).toBe(one);
  await expect(one).rejects.toThrow("damaged-shared-file");
  await expect(b.memo("file", ["address", 42], verify)).rejects.toThrow("damaged-shared-file");
  expect(calls).toBe(2);
});

it("drains a failed statement and refuses later queries without executing them", async () => {
  let calls = 0;
  const batch = createEvidenceBatch(async () => { calls++; throw new Error("sql-failed"); });
  const pending = Array.from({ length: 17 }, (_, n) => batch.query("SELECT $1::integer", [n]));
  const results = await Promise.allSettled(pending);
  expect(results.every((result) => result.status === "rejected" && result.reason.message === "sql-failed")).toBe(true);
  await expect(batch.query("SELECT 1")).rejects.toThrow("sql-failed");
  expect(calls).toBe(1);
});

it("refuses malformed inventories and oversized retained metadata", async () => {
  const malformed = createEvidenceBatch(async () => ({ rows: [{ ordinal: 0, rows: [] }, { ordinal: 0, rows: [] }] }));
  await expect(Promise.all([malformed.query("SELECT 1"), malformed.query("SELECT 2")])).rejects.toThrow("training-evidence-inventory-mismatch");
  const large = createEvidenceBatch(async () => ({ rows: [{ ordinal: 0, rows: [{ n: "x".repeat(EVIDENCE_BATCH_BOUNDS.bytes) }] }] }));
  await expect(large.query("SELECT 1")).rejects.toThrow("training-evidence-bounds-refused");
});
