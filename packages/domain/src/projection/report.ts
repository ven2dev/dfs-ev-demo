/** Explicit JSON encoding: numeric nonfinite scores are strings, never missing metrics. */
export function serializeReport(report: ReturnType<typeof import("./evaluation.ts").evaluate>): string {
  return JSON.stringify({ encodingVersion: "projection-report-json-v1", report }, (_key, value: unknown) => {
    if (typeof value !== "number" || Number.isFinite(value)) return value;
    if (value === Infinity) return "positive-infinity";
    // Neither NaN nor negative infinity is a valid metric produced by this library.
    throw new Error("invalid nonfinite report value");
  }, 2);
}
