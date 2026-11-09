import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { cleanupProducerRaw, openProducerJournal } from "../../scripts/feature-store/producer-capacity-runtime.ts";
import { capacitySchedule, attemptId, clockOffset } from "../../scripts/feature-store/producer-capacity-contract.ts";
import { timeProducerQueries } from "../../scripts/feature-store/producer-capacity-observe.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey } from "../../src/featureStore/objectStore.ts";

describe("#169 attempt controls", () => {
  it("pins 30 unique attempts, each block cold then warm with no replacement", () => {
    const schedule = capacitySchedule(); expect(schedule).toHaveLength(30);
    expect(new Set(schedule.map(attemptId)).size).toBe(30);
    for (let i = 0; i < 30; i += 2) expect(schedule[i + 1]).toEqual({ ...schedule[i], temperature: "warm" });
  });
  for (const [offset, pass] of [[250, true], [-250, true], [250.001, false], [-250.001, false], [30_000, false]] as const)
    it(`clock offset ${offset}: ${pass}`, () => {
      expect(clockOffset(Array.from({ length: 10 }, () => ({ hostBeforeMs: 1000, hostAfterMs: 1002, databaseMs: 1001 + offset }))).pass).toBe(pass);
    });
  it("refuses malformed or missing clock observations", () => {
    expect(() => clockOffset([])).toThrow(/observations/);
    expect(() => clockOffset(Array.from({ length: 10 }, () => ({ hostBeforeMs: 2, hostAfterMs: 1, databaseMs: 1 })))).toThrow();
  });
  it("never overwrites started/results or an existing run and keeps ordered events", async () => {
    const root = await mkdtemp(join(tmpdir(), "dfs169-journal-")), directory = join(root, "run");
    const journal = await openProducerJournal(directory);
    try {
      await journal.record("sample.started.json", { started: true });
      await expect(journal.record("sample.started.json", {})).rejects.toThrow(/EEXIST/);
      await expect(openProducerJournal(directory)).rejects.toThrow(/EEXIST/);
      journal.event({ index: 1 }); journal.event({ index: 2 }); await journal.flush();
      expect(await readFile(join(directory, "events.jsonl"), "utf8")).toBe('{"index":1}\n{"index":2}\n');
    } finally { await journal.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("checks hashes/sizes then deletes destination bytes through ObjectStore", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dfs169-cleanup-")));
    try {
      const store = await openLocalObjectStore(root), bytes = Buffer.from("synthetic-only"), key = objectKey("raw", bytes);
      await store.putIfAbsent(key, bytes);
      await expect(cleanupProducerRaw({ ...store, get: async () => Buffer.from("corrupt") })).rejects.toThrow(/integrity/);
      expect(await store.head(key)).not.toBeNull();
      expect(await cleanupProducerRaw(store)).toMatchObject({ verified: true, deleted: true, objects: [{ key, byteSize: bytes.length }] });
      expect(await store.head(key)).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("retains completed/failed query durations and latches off later SQL", async () => {
    const notifications: unknown[] = [];
    const client = { query: async (sql: string) => { if (sql === "fail") throw new Error("failure"); return { rows: [] }; } } as unknown as Client;
    const measured = timeProducerQueries(client, q => notifications.push(q));
    await measured.client.query("BEGIN"); await expect(measured.client.query("fail")).rejects.toThrow(/failure/);
    measured.stop(); await expect(measured.client.query("late")).rejects.toThrow(/after-stop/);
    expect(measured.statements.map(q => [q.index, q.status])).toEqual([[1, "completed"], [2, "failed"]]);
    expect(notifications).toHaveLength(4);
    expect(measured.statements.every(q => Number.isFinite(q.elapsedMs) && q.elapsedMs >= 0)).toBe(true);
  });
});
