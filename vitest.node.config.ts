import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

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
    include: ["src/lib/*.server.test.ts"],
  },
  ssr: {
    resolve: {
      conditions: ["react-server"],
    },
  },
});
