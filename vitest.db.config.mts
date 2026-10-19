import { defineConfig } from "vitest/config";

export default defineConfig({
  // DB tests never read .env, .env.local, or application credentials.
  envDir: false,
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    setupFiles: ["./tests/db/setup.ts"],
    fileParallelism: false,
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
