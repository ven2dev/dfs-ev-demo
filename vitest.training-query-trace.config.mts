import { defineConfig } from "vitest/config";

// Small distinct-consumer diagnostic, separate from correctness/capacity gates.
export default defineConfig({
  envDir: false,
  test: {
    environment: "node",
    include: ["tests/db/trainingQueryConcurrency.bench.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
