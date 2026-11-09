import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { processTestGlob, processTestTimeout } from "./vitest.process.config.mts";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    projects: [
      { test: { name: "browser-unit", exclude: [processTestGlob] } },
      { test: { name: "browser-process", include: [processTestGlob], testTimeout: processTestTimeout } },
    ],
    exclude: ["packages/db/**", "services/pipeline/tests/**/*.check.mts", "apps/web/tests/db/**", "services/pipeline/tests/creator/**", "**/node_modules/**", "apps/web/src/lib/*.server.test.ts", "tests/db/**", "services/pipeline/tests/feature-store/**", "packages/domain/tests/projection/**"],
  },
});
