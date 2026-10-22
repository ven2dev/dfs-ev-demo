import { defineConfig } from "vitest/config";
import nodeConfig from "./vitest.node.config";

// Disposable local integration fixture; excluded from the web app build and default CI suite.
export default defineConfig({
  ...nodeConfig,
  test: { ...nodeConfig.test, fileParallelism: false, include: ["tests/bench61-postgres.test.ts","tests/bench61-functional-postgres.test.ts"] },
});
