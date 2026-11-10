import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { processTestGlob, processTestTimeout } from "./vitest.process.config.mts";

// Separate config + separate process from vitest.config.ts's jsdom/RTL
// run -- confirmed by spike that ssr.resolve.conditions leaks into the
// SAME process's jsdom resolution (breaks react-dom/client) even when
// docs suggest the two pipelines are independent. A fully separate
// `vitest run --config` invocation, with its own worker pool, avoids
// that entirely.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
    projects: [
      {
        test: {
          name: "node-unit",
          include: ["apps/web/src/lib/*.server.test.ts", "services/pipeline/tests/feature-store/**/*.test.ts", "packages/domain/tests/projection/**/*.test.ts", "packages/db/tooling/tests/unit/**/*.test.ts"],
          exclude: [processTestGlob],
        },
      },
      {
        test: {
          name: "node-process",
          include: ["services/pipeline/tests/feature-store/**/*.process.test.ts"],
          testTimeout: processTestTimeout,
        },
      },
    ],
  },
  ssr: {
    resolve: {
      conditions: ["react-server"],
    },
  },
});
