import { Client } from "pg";
import { expect, it } from "vitest";
import { createScratchHarness } from "./scratch.mjs";

it("scratch snapshots clone only registered disposable targets and isolate later writes", async () => {
  const harness = await createScratchHarness(process.env);
  try {
    await harness.withDatabase(async (source: Client, expected: { database: string }) => {
      await source.query("CREATE TABLE snapshot_probe(id integer PRIMARY KEY)");
      await source.query("INSERT INTO snapshot_probe VALUES(1)");
      await expect(harness.withDatabase(() => { throw new Error("unexpected callback"); }, {
        template: { ...expected, database: "postgres" },
      })).rejects.toThrow("Unregistered scratch target refused");
      await expect(harness.withDatabase(() => { throw new Error("unexpected callback"); }, {
        template: { ...expected, user: "unregistered-user" },
      })).rejects.toThrow("Unregistered scratch target refused");
      await source.end();
      await harness.withDatabase(async (clone: Client, cloned: { database: string }) => {
        expect(cloned.database).not.toBe(expected.database);
        expect((await clone.query("SELECT * FROM snapshot_probe")).rows).toEqual([{ id: 1 }]);
        await clone.query("INSERT INTO snapshot_probe VALUES(2)");
      }, { template: expected });
      await harness.withDatabase(async (clone: Client) => {
        expect((await clone.query("SELECT * FROM snapshot_probe")).rows).toEqual([{ id: 1 }]);
      }, { template: expected });
    });
  } finally { await harness.close(); }
});
