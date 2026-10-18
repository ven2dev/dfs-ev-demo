import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
// Spike lane: every case in these files uses its own scratch database.
// Primary-database bootstrap and lease cases remain in the unchanged serial lane.
export default defineConfig({envDir:false,test:{environment:"node",include:["tests/db/sourceClaims.spike*.test.ts","tests/db/predictive.test.ts"],fileParallelism:true,maxWorkers:Math.min(3, Math.max(1, availableParallelism() - Math.max(1, Math.floor(availableParallelism() / 4)))),passWithNoTests:false,testTimeout:30000,hookTimeout:60000}});
