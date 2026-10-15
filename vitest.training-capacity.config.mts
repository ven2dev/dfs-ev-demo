import { defineConfig } from "vitest/config";

// Opt-in: capacity measurements do not run in the ordinary correctness gate.
// The benchmark owns registered scratch databases; it never loads app .envs.
export default defineConfig({
  envDir: false,
  test: {
    environment: "node",
    include: ["tests/db/trainingCapacity.bench.ts"],
    fileParallelism: false,
    // Includes checked fixture publication and all matrix calls. Individual
    // training APIs retain their normal 10/30-second production ceilings.
    testTimeout: 900_000,
  },
});
