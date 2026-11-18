import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Alignment tooling never loads the owner's private dotenv files.
  envDir: false,
  ssr: { resolve: { conditions: ["react-server"] } },
  test: {
    environment: "node",
    include: [fileURLToPath(new URL("./tests/config-definition-import.probe.mts", import.meta.url))],
    passWithNoTests: false,
  },
});
