import { defineConfig } from "vitest/config";

export default defineConfig({
  // DB tests never read .env, .env.local, or application credentials.
  envDir: false,
  test: {
    environment: "node",
    include: ["packages/db/tooling/tests/**/*.test.ts", "apps/web/tests/db/**/*.test.ts", "services/pipeline/tests/creator/**/*.test.ts"],
    setupFiles: ["./packages/db/tooling/tests/setup.ts"],
    fileParallelism: false,
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
