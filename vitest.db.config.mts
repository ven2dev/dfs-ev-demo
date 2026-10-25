import { defineConfig } from "vitest/config";

export default defineConfig({
  // DB tests never read .env, .env.local, or application credentials.
  envDir: false,
  test: {
    environment: "node",
    include: ["packages/db/tooling/tests/**/*.test.ts", "tests/db/**/*.test.ts", "services/pipeline/tests/creator/**/*.test.ts"],
    // Generic infrastructure unit cases run in the Node unit lane. Keeping them
    // out of this PostgreSQL config prevents a move from silently adding DB work.
    exclude: ["packages/db/tooling/tests/unit/**"],
    setupFiles: ["./packages/db/tooling/tests/setup.ts"],
    fileParallelism: false,
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
