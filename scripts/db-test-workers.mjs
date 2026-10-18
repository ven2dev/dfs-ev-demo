import { availableParallelism } from "node:os";

// Reserve the serial lane's Node workers before assigning scratch workers.
// Three scratch workers reproduced the hosted spike on a four-CPU runner.
export function databaseTestWorkers(cpus = availableParallelism()) {
  if (!Number.isInteger(cpus) || cpus < 1) throw new Error("Invalid DB test CPU count.");
  const nodeWorkers = Math.max(1, Math.floor(cpus / 4));
  return Object.freeze({ availableCPUs: cpus, nodeWorkers,
    scratchWorkers: Math.min(3, Math.max(1, cpus - nodeWorkers)), overlap: cpus > 1 });
}
