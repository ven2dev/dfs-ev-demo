import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { EVScore, PlayerPropDirection } from "@dfs-ev/domain";
import { computeEV, type EVPipelineInput, type EVPipelineResult } from "@dfs-ev/domain/ev";

describe("domain package consumer contract", () => {
  it("runs the pipeline public-package contract in the regular Node test lane", () => {
    for (const cwd of [new URL("../../../../", import.meta.url), new URL("../../", import.meta.url)]) {
      const result = spawnSync(process.execPath, ["--test", fileURLToPath(new URL("../package-contract.check.mjs", import.meta.url)), fileURLToPath(new URL("../paths-contract.check.mjs", import.meta.url))], {
        cwd: fileURLToPath(cwd),
        env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 15000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr + result.stdout).toBe(0);
    }
  });
  it("shares the leaf types directly with calculation consumers", () => {
    expectTypeOf<EVPipelineInput["direction"]>().toEqualTypeOf<PlayerPropDirection>();
    expectTypeOf<EVPipelineResult["evScore"]>().toEqualTypeOf<EVScore>();
    const direction: PlayerPropDirection = "under";
    const score: EVScore = computeEV({ recentGameStats: [100, 300], line: 199.5,
      sampleWindow: 3, windSpeedMph: 0, precipitationMm: 0, shadowCoverageRate: 0,
      impliedProb: .5, direction }).evScore;
    expect(score).toEqual({ modelProb: .5, impliedProb: .5, edge: 0 });
  });

  it("runs native Node 24 from the pipeline workspace through real source links and rejects private subpaths", () => {
    const script = `
      import assert from "node:assert/strict";
      import { realpath } from "node:fs/promises";
      import { fileURLToPath } from "node:url";
      import { equalMassSupport, probabilityAt, priceSide } from "@dfs-ev/domain/empirical";
      import { priceSide as legacyPriceSide } from "@dfs-ev/domain/baseline";
      import { consensusDevigAtLine } from "@dfs-ev/domain/consensus-devig";
      import { devigTwoWay } from "@dfs-ev/domain/devig";
      import { computeEV } from "@dfs-ev/domain/ev";
      import { createEmpiricalAdapter } from "./src/featureStore/empiricalAdapter.ts";
      assert.equal(process.versions.node.split(".")[0], "24");
      const resolved = fileURLToPath(import.meta.resolve("@dfs-ev/domain/empirical"));
      assert.equal(resolved, await realpath(resolved));
      assert(resolved.endsWith("/packages/domain/src/projection/empirical.ts"));
      assert(!resolved.includes("/node_modules/"));
      await assert.rejects(import("@dfs-ev/domain/src/projection/empirical.ts"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
      assert.equal(priceSide, legacyPriceSide);
      assert.deepEqual(probabilityAt(equalMassSupport([100, 300]), 199.5),
        { underProbability: .5, pushProbability: 0, overProbability: .5 });
      assert.equal(devigTwoWay(2, 2).impliedProbOver, .5);
      assert.equal(consensusDevigAtLine([{ bookmakerKey: "synthetic", point: 1, overPrice: 2, underPrice: 2 }], 1).impliedProbOver, .5);
      assert.equal(computeEV({ recentGameStats: [100, 300], line: 199.5, sampleWindow: 3,
        windSpeedMph: 0, precipitationMm: 0, shadowCoverageRate: 0, impliedProb: .5, direction: "over" }).evScore.edge, 0);
      const adapter = await createEmpiricalAdapter();
      const refusal = await adapter({ query() { throw new Error("unexpected database query"); } }, {});
      assert.equal(refusal.response.reason, "invalid-request");
      assert.equal(refusal.work.statements, 0);
      console.log(JSON.stringify({ resolved, verdict: "pass" }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("pass");
  });
});
