import "server-only";
import { paidAdmissionCapabilitySql, type AdmissionQuery } from "@dfs-ev/db/runtime";

export type PaidOddsCapability = "ready" | "not-installed" | "unavailable";
// No rejected promise is cached forever. Successful ready state is latched;
// missing schema/keys and transient failures retry at most once per 5 seconds.
// C2 wires this factory to instrumentation and the paid boundary; no activation
// or environment flag is introduced by C1.
export const createPaidOddsStartup = (deps: {
  query: AdmissionQuery;
  keysConfigured: () => boolean;
  warn: (reason: "not-installed" | "capability-unavailable") => void;
  now?: () => number;
}) => {
  const now = deps.now ?? (() => performance.now());
  let pending: Promise<PaidOddsCapability> | undefined;
  let state: PaidOddsCapability = "not-installed", retryAfter = Number.NEGATIVE_INFINITY;
  let reported: PaidOddsCapability | undefined;
  const initialize = (): Promise<PaidOddsCapability> => {
    if (pending) return pending;
    if (state === "ready" || now() < retryAfter) return Promise.resolve(state);
    pending = Promise.resolve().then(async () => {
      try {
        if (!deps.keysConfigured()) return "not-installed" as const;
        const rows = await deps.query(paidAdmissionCapabilitySql, []);
        if (rows.length !== 1 || typeof rows[0]?.ready !== "boolean") throw new Error("Invalid capability result");
        return rows[0].ready ? "ready" as const : "not-installed" as const;
      } catch { return "unavailable" as const; }
    }).then(result => {
      state = result;
      retryAfter = now() + 5000;
      if (result !== "ready" && reported !== result) deps.warn(result === "not-installed" ? "not-installed" : "capability-unavailable");
      reported = result;
      return result;
    }).finally(() => { pending = undefined; });
    return pending;
  };
  return { initialize, status: () => state };
};
