import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: { environment: "node", include: ["tests/db/trainingWitnessCapacity.bench.ts"], fileParallelism: false },
});
