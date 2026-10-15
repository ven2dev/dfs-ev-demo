import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: {
    environment: "node",
    include: ["tests/db/trainingProfile.bench.ts"],
    fileParallelism: false,
    // Fixture setup is outside API budgets. Instrumented APIs keep 10/30s.
    testTimeout: 900_000,
  },
});
