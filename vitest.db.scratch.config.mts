import { defineConfig } from "vitest/config";
import { SCRATCH_FILES } from "./scripts/db-test-lanes.mjs";
import { databaseTestWorkers } from "./scripts/db-test-workers.mjs";

export default defineConfig({
  envDir: false,
  test: {
    environment: "node",
    include: [...SCRATCH_FILES],
    fileParallelism: true,
    maxWorkers: databaseTestWorkers().scratchWorkers,
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
