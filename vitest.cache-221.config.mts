import { defineConfig } from "vitest/config";
import database from "./vitest.db.config.mts";

// Explicit opt-in only. No elapsed-time assertions run in ordinary CI suites.
export default defineConfig({
  ...database,
  test: { ...database.test, include: ["tests/db/cache221.qualification.ts"], testTimeout: 60_000 },
});
