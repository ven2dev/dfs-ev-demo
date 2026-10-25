// Admission policy for this disposable SHA: only the hosted hold-probe actions.
// The earlier functional actions stay in code for their regressions but are not admitted.
export const probeActions = ["probe-setup","probe-qualify","probe-run","probe-cleanup"] as const;
export type ProbeAction = typeof probeActions[number];
export const isProbeAction = (action: unknown): action is ProbeAction =>
  typeof action === "string" && (probeActions as readonly string[]).includes(action);
// Setup needs the worker password; qualify and run log in as the worker. Cleanup is
// operator-only, so it stays available without a worker credential.
export const probeWorkerRequired = (action: unknown) =>
  action === "probe-setup" || action === "probe-qualify" || action === "probe-run";
