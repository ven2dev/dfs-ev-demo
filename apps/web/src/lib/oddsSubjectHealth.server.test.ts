import { describe, expect, it } from "vitest";
import { evaluateSubjectHealth, proposedSubjectThresholds } from "./oddsSubjectHealth";
import type { SubjectWindow } from "@dfs-ev/db/runtime";
const counts = { admitted: 0, denied: 0, wouldDeny: 0, floorDenied: 0, anonymous: 0, signedIn: 0 };
const window = (admitted: number, denied = 0, wouldDeny = 0): SubjectWindow => ({ window: "1h", totals: counts,
 topAdmitted: [{ subject: "fixture", ...counts, admitted }], topDenied: [{ subject: "fixture", ...counts, denied }],
 topWouldDeny: [{ subject: "fixture", ...counts, wouldDeny }] });
describe("subject policy health", () => {
  it("never activates proposed thresholds implicitly", () => expect(evaluateSubjectHealth([window(999999)])).toEqual({ status: "policy-pending", reasons: [] }));
  it("evaluates warning, critical and shadow would-deny only with an explicit policy", () => {
    expect(evaluateSubjectHealth([window(99)], proposedSubjectThresholds).status).toBe("ok");
    expect(evaluateSubjectHealth([window(100)], proposedSubjectThresholds).status).toBe("warning");
    expect(evaluateSubjectHealth([window(0, 0, 500)], proposedSubjectThresholds).status).toBe("critical");
    expect(evaluateSubjectHealth([], proposedSubjectThresholds).status).toBe("unavailable");
  });
  it("refuses malformed policy instead of silently activating it", () => expect(() => evaluateSubjectHealth([], { ...proposedSubjectThresholds,
    deniedPerSubject1h: { warning: 100, critical: 1 } })).toThrow("Invalid subject health policy"));
});
