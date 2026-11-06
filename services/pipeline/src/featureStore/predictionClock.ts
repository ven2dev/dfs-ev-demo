import { EMPIRICAL_DEADLINE_MS } from "./empiricalAdapter.ts";

// Same-process performance.now() only. A caller may shorten the default,
// never extend it; invalid clocks must not silently receive a fresh budget.
export const predictionDeadline = (started: number, supplied: unknown): number | undefined => {
  const maximum = started + EMPIRICAL_DEADLINE_MS;
  if (supplied === undefined) return maximum;
  return typeof supplied === "number" && Number.isFinite(supplied) && supplied <= maximum
    ? supplied : undefined;
};
