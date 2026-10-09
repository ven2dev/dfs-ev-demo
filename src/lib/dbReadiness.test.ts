import { describe, expect, it } from "vitest";
import { DB_READINESS_MANIFEST } from "./dbReadinessManifest";
import { DB_READINESS_HISTORY_LIMIT, evaluateDatabaseReadiness, readinessRelations } from "./dbReadiness";

const history = () => DB_READINESS_MANIFEST.migrations.map((migration) => ({
  ...migration, runner_version: 1, provenance: "adopted", applied_at: "2026-10-07T05:46:23.019Z",
}));
const ready = () => ({ ledgerPresent: true, requiredTablesPresent: true, history: history() });

describe("database readiness", () => {
  it("distinguishes absent, empty and valid adopted migration history", () => {
    expect(evaluateDatabaseReadiness({ ...ready(), ledgerPresent: false, history: [] })).toMatchObject({
      status: "not-ready", schemaVersion: 0, reasons: ["migration-ledger-missing"],
    });
    expect(evaluateDatabaseReadiness({ ...ready(), history: [] })).toMatchObject({
      status: "not-ready", schemaVersion: null, reasons: ["migration-history-invalid"],
    });
    expect(evaluateDatabaseReadiness(ready())).toEqual({ status: "ready", schemaVersion: 3,
      minimumVersion: 2, maximumKnownVersion: 3, reasons: [], warnings: [] });
    expect(evaluateDatabaseReadiness({ ...ready(), history: history().slice(0, 2) })).toMatchObject({
      status: "ready", schemaVersion: 2, minimumVersion: 2, maximumKnownVersion: 3, reasons: [], warnings: [],
    });
  });

  it("accepts valid newer history with an explicit schema-ahead warning", () => {
    const rows = [...history(), { version: 4, filename: "0004_future.sql", sha256: "a".repeat(64),
      runner_version: 1, provenance: "executed", applied_at: "2026-10-08T00:00:00.000Z" }];
    expect(evaluateDatabaseReadiness({ ...ready(), history: rows })).toMatchObject({
      status: "ready", schemaVersion: 4, reasons: [], warnings: ["schema-ahead"],
    });
    rows[3].sha256 = "invalid";
    expect(evaluateDatabaseReadiness({ ...ready(), history: rows }).reasons).toEqual(["migration-history-invalid"]);
  });

  it("refuses behind schemas and missing required tables", () => {
    expect(evaluateDatabaseReadiness({ ...ready(), history: history().slice(0, 1) })).toMatchObject({
      status: "not-ready", schemaVersion: 1, reasons: ["schema-behind"],
    });
    expect(evaluateDatabaseReadiness({ ...ready(), requiredTablesPresent: false })).toMatchObject({
      status: "not-ready", schemaVersion: 3, reasons: ["required-tables-missing"],
    });
    expect(readinessRelations(DB_READINESS_MANIFEST.requiredTables.map((name) => ({ name, present: true }))))
      .toEqual({ ledgerPresent: false, requiredTablesPresent: true });
    expect(readinessRelations([{ name: "db_migrations", present: true }]))
      .toEqual({ ledgerPresent: true, requiredTablesPresent: false });
  });

  it("rejects holes, duplicate versions, unknown runners, altered checksums and malformed rows", () => {
    for (const patch of [
      { version: 2 }, { version: "1" }, { filename: "0001_other.sql" }, { sha256: "b".repeat(64) },
      { sha256: null }, { runner_version: 2 }, { provenance: "unknown" }, { applied_at: null },
      { applied_at: "infinity" },
    ]) {
      const rows = history();
      const values = [{ ...rows[0], ...patch }, rows[1]];
      expect(evaluateDatabaseReadiness({ ...ready(), history: values })).toMatchObject({
        status: "not-ready", schemaVersion: null, reasons: ["migration-history-invalid"],
      });
    }
    for (const values of [[history()[1]], [history()[0], history()[0]], [null], ["invalid"]]) {
      expect(evaluateDatabaseReadiness({ ...ready(), history: values }).reasons).toEqual(["migration-history-invalid"]);
    }
    expect(evaluateDatabaseReadiness({ ...ready(), history: Array(DB_READINESS_HISTORY_LIMIT + 1).fill(null) })
      .reasons).toEqual(["migration-history-limit-exceeded"]);
  });
});
