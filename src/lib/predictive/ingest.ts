import type { Dataset } from "./types.ts";
import type { createLocalPredictiveStore } from "./persistence.ts";

// Dependency-injected local publication, with durable fixed failure state.
// Qualified network acquisition and its request/runtime budgets are delivery 3.
export const ingestLocalDataset = async (
  store: Awaited<ReturnType<typeof createLocalPredictiveStore>>, id: string, dataset: Dataset, now: string,
) => {
  try { return await store.publish(id, dataset, now); }
  catch { return store.recordRefusal(id, dataset, now); }
};
