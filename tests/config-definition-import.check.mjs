import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
test("#287 real definitions align with catalog policy through the TS loader without input or client work", () => {
  const directory = mkdtempSync(join(tmpdir(), "dfs287-config-import-"));
  try {
    // A private dotenv read would introduce this synthetic marker in the child.
    writeFileSync(join(directory, ".env.local"), "SYNTHETIC_DOTENV_287=must-not-load\n");
    const result = spawnSync(process.execPath, [
      join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", directory,
      "--config", join(root, "vitest.configuration.config.mts"),
    ], { cwd: root, env: { PATH: process.env.PATH, NODE_ENV: "test", CI: "1" },
      encoding: "utf8", timeout: 60_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout.match(/CONFIGURATION_IMPORT_PROBE (\{[^\n]+\})/)?.[1] ?? "null");
    assert(receipt, "definition import probe did not execute");
    for (const name of ["inputReads", "parserCalls", "sdkCalls", "sqlCalls", "networkCalls", "privateDotenvReads"])
      assert.equal(receipt[name], 0, name);
    assert(receipt.serverInputs > 0 && receipt.clientInputs > 0);
    assert.deepEqual(receipt.alignment, { server: receipt.serverInputs, client: receipt.clientInputs });
    console.info("CONFIGURATION_IMPORT_PROBE " + JSON.stringify(receipt));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
