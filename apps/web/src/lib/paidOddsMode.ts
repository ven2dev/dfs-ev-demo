import "server-only";
import type { PaidOddsMode } from "./config.server";
import type { PaidOddsCapability } from "./paidOddsStartup";
import type { OddsCacheStatus } from "./oddsCacheStartup";

// No I/O: project existing readiness state, never initialize a dependency for health.
export const createPaidOddsMode = (deps: {
  read: () => PaidOddsMode;
  capability: () => PaidOddsCapability;
  sharedCache: () => OddsCacheStatus;
  warn: (reason: "mode-configuration-unavailable") => void;
}) => {
  let selected: PaidOddsMode | null | undefined;
  const requested = (): PaidOddsMode | null => {
    if (selected === undefined) {
      try { selected = deps.read(); }
      catch { selected = null; deps.warn("mode-configuration-unavailable"); }
    }
    return selected;
  };
  const health = () => {
    const requestedMode = requested();
    const capability = deps.capability(), sharedCache = deps.sharedCache();
    const modeReasons: string[] = [];
    if (requestedMode === null) modeReasons.push("mode-configuration-unavailable");
    if (requestedMode === "enforce") {
      if (capability !== "ready") modeReasons.push("limiter-not-ready");
      if (sharedCache !== "shared") modeReasons.push("shared-cache-not-ready");
    }
    const effectiveMode: PaidOddsMode = requestedMode === "enforce" && modeReasons.length === 0 ? "enforce" : "log-only";
    return { requestedMode, effectiveMode, mode: effectiveMode, capability, sharedCache, modeReasons };
  };
  return { requested, health };
};
