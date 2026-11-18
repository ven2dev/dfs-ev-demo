import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const proposal = new URL("../../../proposals/222_provider_credit_reservations.sql", import.meta.url);
const assertPoolSafe = (source: string) => {
  const sql = source.replace(/--[^\n]*/g, "");
  // UPDATE ... SET is DML, not a session SET command. Function settings are
  // explicitly transaction-local set_config(...,true), with qualified objects.
  if (/\bpg_(?:try_)?advisory_lock\s*\(|(?:^|[;\n])\s*SET\s+(?!LOCAL\b)|\b(?:TEMP|TEMPORARY|LISTEN|NOTIFY|PREPARE|DEALLOCATE)\b/i.test(sql)) {
    throw new Error("Session feature outside transaction-pool contract");
  }
  const settings = sql.match(/\bset_config\s*\([^)]*\)/gi) ?? [];
  if (settings.some(call => !/,\s*true\s*\)$/i.test(call))) throw new Error("Non-local transaction setting");
  if (/FROM\s+public\.(?:event_market_odds_cache|odds_collection_checkpoints)[^;]*FOR\s+(?:(?:NO\s+KEY\s+)?UPDATE|(?:KEY\s+)?SHARE)/i.test(sql)) {
    throw new Error("Resource row locking exceeds reservation contract");
  }
};

describe("#222 SQL pool and ownership contract guard", () => {
  it("keeps the proposal session-free, with no resource-row write locks", async () => {
    assertPoolSafe(await readFile(proposal, "utf8"));
  });
  it.each([
    "SELECT pg_advisory_lock(1);", "SET search_path=public;", "SELECT set_config('search_path','public',false);",
    "CREATE TEMP TABLE bypass(id int);", "LISTEN bypass;", "NOTIFY bypass;", "PREPARE bypass AS SELECT 1;",
    "SELECT * FROM public.event_market_odds_cache FOR UPDATE;",
    "SELECT * FROM public.odds_collection_checkpoints FOR UPDATE;",
    "SELECT * FROM public.event_market_odds_cache FOR NO KEY UPDATE;",
    "SELECT * FROM public.event_market_odds_cache FOR SHARE;",
  ])("refuses added unsafe feature: %s", async mutation => {
    expect(() => assertPoolSafe(mutation)).toThrow();
  });
  it("permits account locking and transaction-local configuration", () => {
    assertPoolSafe("SELECT * FROM provider_credit.account FOR UPDATE;\nSELECT pg_catalog.set_config('search_path','pg_catalog',true);\nUPDATE provider_credit.account SET pending_count=1;");
  });
});
