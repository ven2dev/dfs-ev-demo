import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createEmpiricalAdapter } from "@dfs-ev/pipeline/feature-store/empirical-adapter";
import { getNflRegularSeasonWeek } from "@dfs-ev/pipeline/creator/season-calendar";

// Native Node also runs this contract in a clean, runtime-only workspace install.
// That catches dependencies accidentally supplied by root tooling or the web app.
test("all public pipeline exports resolve through real TypeScript workspace sources", async () => {
  assert.equal(process.versions.node.split(".")[0], "24");
  assert.doesNotMatch(process.execArgv.join(" ") + " " + (process.env.NODE_OPTIONS ?? ""), /--preserve-symlinks/);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const subpath of Object.keys(manifest.exports)) {
    const specifier = manifest.name + subpath.slice(1);
    const resolved = fileURLToPath(import.meta.resolve(specifier));
    assert.equal(resolved, await realpath(resolved));
    assert.ok(resolved.startsWith(fileURLToPath(new URL("../src/", import.meta.url))));
    assert.ok(!resolved.includes("/node_modules/"));
    await import(specifier);
  }
});

test("private and unknown pipeline paths remain inaccessible", async () => {
  for (const specifier of ["@dfs-ev/pipeline", "@dfs-ev/pipeline/src/featureStore/empiricalAdapter.ts", "@dfs-ev/pipeline/scripts/creator-corpus/cli.ts", "@dfs-ev/pipeline/unknown"]) {
    await assert.rejects(import(specifier), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});

test("public adapter resolves SQL and refuses invalid input without a database read", async () => {
  const adapter = await createEmpiricalAdapter();
  const result = await adapter({ query() { throw new Error("unexpected database query"); } }, {});
  assert.equal(result.response.reason, "invalid-request");
  assert.deepEqual(result.work, { statements: 0, rightsChecks: 0 });
});

test("public creator calendar consumes the shared domain calendar", () => {
  const week = getNflRegularSeasonWeek(new Date("2025-10-09T15:00:00Z"));
  assert.equal(week.season, 2025);
  assert.equal(week.week, 6);
  assert.equal(getNflRegularSeasonWeek(new Date("2025-02-09T23:30:00Z")), null);
});
