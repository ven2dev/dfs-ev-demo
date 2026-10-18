import type { Client } from "pg";
import { createScratchHarness } from "./scratch.mjs";
import { getTemplateReference } from "./templates.mts";
import { parseTestDatabaseUrl } from "./target.mts";

export type ScratchConfig = ReturnType<typeof parseTestDatabaseUrl>;
export type ScratchTarget = { expected: ScratchConfig; assertTarget: (config: object) => void };

export async function withMigratedDatabase<T>(environment: NodeJS.ProcessEnv,
  run: (client: Client, target: ScratchTarget) => Promise<T>, version?: number): Promise<T> {
  const reference = await getTemplateReference(environment, version);
  const harness = await createScratchHarness(environment);
  try {
    return await harness.withDatabase((client: Client, expected: ScratchConfig) =>
      run(client, { expected, assertTarget: harness.assertTarget }), reference);
  } finally { await harness.close(); }
}
