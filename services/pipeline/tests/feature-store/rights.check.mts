import assert from "node:assert/strict";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";

// Fixed valid-time instants avoid sleeps; recorded_at is always the DB clock.
test("#163 shared effective-rights policy", async t => {
  await withFeatureStoreDatabase(async ({ writer, reader }) => {
    let ordinal = 0;
    const profile = async () => {
      const id = `rights-${++ordinal}`;
      await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
        VALUES($1,'synthetic','stats','rights-contract-v1','{}')`, [id]); return id;
    };
    const decide = async (id: string, uses: string[], from = "2020-01-01T00:00:00Z", until: string | null = null) =>
      (await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,valid_until,rationale)
        VALUES($1,$2,$3,$4,'synthetic rights policy test') RETURNING decision_id,recorded_at::text`, [id, uses, from, until])).rows[0];
    const select = async (id: string, at = "2025-01-01T00:00:00Z", known?: string) =>
      (await reader.query(`WITH clock AS MATERIALIZED(SELECT clock_timestamp() AS now)
        SELECT r.* FROM clock CROSS JOIN LATERAL fs138.effective_rights($1,$2::timestamptz,coalesce($3::timestamptz,now)) r`, [id, at, known ?? null])).rows[0];
    await t.test("an expired newer grant keeps its identity and refuses effective uses", async () => {
      const id = await profile(); await decide(id, ["research"]);
      const expired = await decide(id, ["research"], "2020-01-01T00:00:00Z", "2021-01-01T00:00:00Z");
      assert.deepEqual(await select(id), { decision_id: expired.decision_id, allowed_uses: [] });
    });
    await t.test("an expired newer denial never reactivates an older grant", async () => {
      const id = await profile(); await decide(id, ["research"]);
      const expired = await decide(id, [], "2020-01-01T00:00:00Z", "2021-01-01T00:00:00Z");
      assert.deepEqual(await select(id), { decision_id: expired.decision_id, allowed_uses: [] });
    });
    await t.test("expiry is exclusive at the exact microsecond boundary", async () => {
      const id = await profile(); await decide(id, ["research"], "2020-01-01T00:00:00Z", "2021-01-01T00:00:00.000001Z");
      assert.deepEqual((await select(id, "2021-01-01T00:00:00.000000Z")).allowed_uses, ["research"]);
      assert.deepEqual((await select(id, "2021-01-01T00:00:00.000001Z")).allowed_uses, []);
    });
    await t.test("a future-effective decision leaves the older grant effective until valid_from", async () => {
      const id = await profile(), old = await decide(id, ["research"]);
      const future = await decide(id, [], "2030-01-01T00:00:00Z");
      assert.equal((await select(id)).decision_id, old.decision_id);
      assert.deepEqual(await select(id, "2030-01-01T00:00:00Z"), { decision_id: future.decision_id, allowed_uses: [] });
    });
    await t.test("a later backdated decision cannot enter an earlier knowledge snapshot", async () => {
      const id = await profile(), old = await decide(id, ["research"]);
      await decide(id, [], "2019-01-01T00:00:00Z");
      assert.deepEqual(await select(id, "2025-01-01T00:00:00Z", old.recorded_at), { decision_id: old.decision_id, allowed_uses: ["research"] });
      assert.deepEqual((await select(id)).allowed_uses, []);
    });
    await t.test("only an explicit newer grant restores uses after expiry", async () => {
      const id = await profile(); await decide(id, ["research"]);
      await decide(id, ["research"], "2020-01-01T00:00:00Z", "2021-01-01T00:00:00Z");
      const restored = await decide(id, ["research"]);
      assert.deepEqual(await select(id), { decision_id: restored.decision_id, allowed_uses: ["research"] });
      assert.equal((await reader.query(`SELECT prosecdef FROM pg_proc WHERE oid='fs138.effective_rights(text,timestamptz,timestamptz)'::regprocedure`)).rows[0].prosecdef, false);
    });
  });
});
