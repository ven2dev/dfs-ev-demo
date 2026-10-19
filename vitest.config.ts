import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["packages/db/**", "services/pipeline/tests/**/*.check.mts", "apps/web/tests/db/**", "services/pipeline/tests/creator/**", "**/node_modules/**", "apps/web/src/lib/*.server.test.ts", "tests/db/**", "services/pipeline/tests/feature-store/**", "packages/domain/tests/projection/**"],
  },
});
