import { availableParallelism } from "node:os";

// Preserve the existing bounded Node migration/catalog concurrency. The retired
// predictive scratch lane no longer needs a separate worker allocation.
export const databaseTestWorkers = (cpus = availableParallelism()) => {
  if (!Number.isInteger(cpus) || cpus < 1) throw new Error("Invalid DB test CPU count.");
  return Object.freeze({ availableCPUs: cpus, nodeWorkers: Math.max(1, Math.floor(cpus / 4)) });
};
