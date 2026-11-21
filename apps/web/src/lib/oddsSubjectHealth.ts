import type { SubjectWindow } from "@dfs-ev/db/runtime";

// Owner review proposals, not supplied inputs or an activated enforcement policy.
export const proposedSubjectThresholds = {
  admittedPerSubject1h: { warning: 100, critical: 500 },
  deniedPerSubject1h: { warning: 100, critical: 500 },
} as const;
export type SubjectHealthPolicy = { admittedPerSubject1h: { warning: number; critical: number }; deniedPerSubject1h: { warning: number; critical: number } };
export const evaluateSubjectHealth = (windows: SubjectWindow[], policy: SubjectHealthPolicy | null = null) => {
  if (!policy) return { status: "policy-pending" as const, reasons: [] as string[] };
  for (const thresholds of Object.values(policy)) {
    if (!Number.isSafeInteger(thresholds.warning) || !Number.isSafeInteger(thresholds.critical) || thresholds.warning < 1 || thresholds.critical <= thresholds.warning) {
      throw new Error("Invalid subject health policy");
    }
  }
  const hour = windows.find(w => w.window === "1h");
  if (!hour) return { status: "unavailable" as const, reasons: ["subject-window-unavailable"] };
  const admitted = hour.topAdmitted[0]?.admitted ?? 0;
  const denied = Math.max(hour.topDenied[0]?.denied ?? 0, hour.topWouldDeny[0]?.wouldDeny ?? 0);
  const critical = admitted >= policy.admittedPerSubject1h.critical || denied >= policy.deniedPerSubject1h.critical;
  const warning = admitted >= policy.admittedPerSubject1h.warning || denied >= policy.deniedPerSubject1h.warning;
  return { status: critical ? "critical" as const : warning ? "warning" as const : "ok" as const,
    reasons: critical || warning ? ["subject-activity-threshold"] : [] };
};
