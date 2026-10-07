import { afterEach, describe, expect, it, vi } from "vitest";
import { DB_READINESS_MANIFEST } from "./dbReadinessManifest";
import { DB_READINESS_DEADLINE_MS, DB_READINESS_HISTORY_LIMIT, DB_READINESS_HISTORY_SQL,
  DB_READINESS_RELATIONS_SQL, DB_READINESS_SETTINGS_SQL } from "./dbReadiness";

const queryMock = vi.fn((text: string, params?: unknown[]) => ({ text, params }));
const transactionMock = vi.fn();
vi.mock("./db", () => ({ getSql: () => ({ transaction: transactionMock }) }));
const { getDatabaseReadinessSnapshot } = await import("./dbReadinessRepo");
const relations = () => [...DB_READINESS_MANIFEST.requiredTables, "db_migrations"]
  .map((name) => ({ name, present: true }));

afterEach(() => { queryMock.mockClear(); transactionMock.mockReset(); vi.restoreAllMocks(); });

describe("getDatabaseReadinessSnapshot", () => {
  it("bounds read-only transactions and the complete HTTP deadline without scanning application rows", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    transactionMock.mockImplementationOnce((callback) => {
      callback({ query: queryMock }); return [[], relations()];
    }).mockImplementationOnce((callback) => {
      callback({ query: queryMock }); return [[], relations(), [{ version: 2 }]];
    });
    await expect(getDatabaseReadinessSnapshot()).resolves.toEqual({
      ledgerPresent: true, requiredTablesPresent: true, history: [{ version: 2 }],
    });
    expect(timeout).toHaveBeenCalledWith(DB_READINESS_DEADLINE_MS);
    expect(queryMock.mock.calls).toEqual([
      [DB_READINESS_SETTINGS_SQL], [DB_READINESS_RELATIONS_SQL, [[...DB_READINESS_MANIFEST.requiredTables, "db_migrations"]]],
      [DB_READINESS_SETTINGS_SQL], [DB_READINESS_RELATIONS_SQL, [[...DB_READINESS_MANIFEST.requiredTables, "db_migrations"]]],
      [DB_READINESS_HISTORY_SQL, [DB_READINESS_HISTORY_LIMIT + 1]],
    ]);
    for (const [, options] of transactionMock.mock.calls) {
      expect(options).toMatchObject({ readOnly: true, isolationLevel: "RepeatableRead", fetchOptions: { signal: expect.any(AbortSignal) } });
    }
    expect(transactionMock.mock.calls[0][1].fetchOptions.signal).toBe(transactionMock.mock.calls[1][1].fetchOptions.signal);
  });

  it("does not read or create a missing ledger", async () => {
    transactionMock.mockImplementationOnce((callback) => {
      callback({ query: queryMock }); return [[], relations().filter((row) => row.name !== "db_migrations")];
    });
    await expect(getDatabaseReadinessSnapshot()).resolves.toEqual({
      ledgerPresent: false, requiredTablesPresent: true, history: [],
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls.some(([query]) => query === DB_READINESS_HISTORY_SQL)).toBe(false);
  });

  it("uses the final snapshot for concurrent relation changes and propagates query failure", async () => {
    transactionMock.mockResolvedValueOnce([[], relations()]).mockResolvedValueOnce([[], [], []]);
    await expect(getDatabaseReadinessSnapshot()).resolves.toEqual({
      ledgerPresent: false, requiredTablesPresent: false, history: [],
    });
    transactionMock.mockRejectedValueOnce(new Error("synthetic database failure"));
    await expect(getDatabaseReadinessSnapshot()).rejects.toThrow("synthetic database failure");
  });
});
