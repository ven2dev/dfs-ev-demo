/** Provider-neutral SQL primitives. No driver initialization, fetch or web policy. */
export type ProviderCreditQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
export type ProviderCreditReason = "reserved" | "uninitialized" | "owner-expired" | "cost-mismatch" |
  "period-mismatch" | "quota-stale" | "insufficient-credit";
export type ProviderCreditReservationInput = {
  id: string;
  mode: "log-only" | "enforce";
  kind: "raw" | "collector";
  resourceId: string;
  ownerId: string;
  sportKey: "americanfootball_nfl";
  marketKeys: readonly string[];
  expectedCost: number;
  period: string;
};
export type ProviderCreditDecision = {
  outcome: "reserved" | "denied" | "shadow" | "replay";
  allowed: boolean;
  reason: ProviderCreditReason;
  reservationId: string;
  cost: number;
  availableCredits: number | null;
  period: string | null;
};
export type ProviderCreditHealth = {
  initialized: boolean;
  period: string | null;
  reason: "ok" | "uninitialized" | "period-mismatch" | "quota-stale";
  severity: "ok" | "critical" | "unavailable";
  unresolvedLiabilityTotal: number;
  unresolvedLiabilityCount: number;
  oldestUnresolvedAgeSeconds: number | null;
  collectorFloor: number;
  availableCredits: number | null;
};
export type CreditResolutionEvidence = {
  kind: "provider-confirmed-no-charge" | "covered-terminal-send";
  reference: string;
  sendCannotResume: true;
  period: string;
};
type OperationResult = {
  outcome: "initialized" | "resolved" | "settled" | "unresolved" | "replay";
  reason?: string;
};
const reasons = new Set<string>(["reserved", "uninitialized", "owner-expired", "cost-mismatch",
  "period-mismatch", "quota-stale", "insufficient-credit"]);
const healthReasons = new Set<string>(["ok", "uninitialized", "period-mismatch", "quota-stale"]);
const outcomes = new Set<string>(["reserved", "denied", "shadow", "replay"]);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableInteger = (value: unknown): value is number | null => value === null || integer(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nullableString = (value: unknown) => value === null || typeof value === "string";

/** Each operation submits one statement. Driver errors are sanitized; no retries.
 * Missing/unavailable values never become zero credit or an allowed decision.
 * Web log-only compatibility is orchestration, deliberately not implemented here.
 */
export const createProviderCreditStore = (query: ProviderCreditQuery) => {
  const call = async (sql: string, params: unknown[]): Promise<Record<string, unknown>> => {
    let rows: Record<string, unknown>[];
    try { rows = await query(sql, params); }
    catch { throw new Error("Provider credit authority unavailable"); }
    if (!Array.isArray(rows) || rows.length !== 1 || !record(rows[0]?.result)) {
      throw new Error("Invalid provider credit result");
    }
    return rows[0].result;
  };
  const operation = async (sql: string, params: unknown[]): Promise<OperationResult> => {
    const result = await call(sql, params);
    if (!["initialized", "resolved", "settled", "unresolved", "replay"].includes(String(result.outcome)) ||
        (result.reason !== undefined && typeof result.reason !== "string")) throw new Error("Invalid provider credit operation");
    return result as OperationResult;
  };
  return {
    async reserve(input: ProviderCreditReservationInput): Promise<ProviderCreditDecision> {
      const result = await call("SELECT provider_credit.reserve($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result", [
        input.id, input.mode, input.kind, input.resourceId, input.ownerId, input.sportKey,
        [...input.marketKeys], input.expectedCost, input.period,
      ]);
      if (!outcomes.has(String(result.outcome)) || !reasons.has(String(result.reason)) ||
          typeof result.allowed !== "boolean" || typeof result.reservationId !== "string" ||
          !integer(result.cost) || result.cost < 1 || result.cost > 12 ||
          !nullableInteger(result.availableCredits) || !nullableString(result.period) ||
          result.reservationId !== input.id ||
          (result.allowed !== (result.outcome === "reserved")) ||
          (result.allowed && (result.reason !== "reserved" || input.mode !== "enforce" || result.cost !== input.expectedCost ||
            result.period !== input.period || result.availableCredits === null || Number(result.availableCredits) < result.cost))) {
        throw new Error("Invalid provider credit decision");
      }
      return result as ProviderCreditDecision;
    },
    reconcile(input: { id: string; actualCost: number; remaining: number | null; used: number | null; period: string | null }) {
      return operation("SELECT provider_credit.reconcile($1,$2,$3,$4,$5) AS result", [
        input.id, input.actualCost, input.remaining, input.used, input.period,
      ]);
    },
    initialize(input: {
      operationId: string; actor: string; remaining: number; used: number; period: string;
      periodEndsAt: string; collectorFloor: number; quotaFreshnessMs: number; evidenceReference: string;
    }) {
      return operation("SELECT provider_credit.initialize($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result", [
        input.operationId, input.actor, input.remaining, input.used, input.period, input.periodEndsAt,
        input.collectorFloor, input.quotaFreshnessMs, input.evidenceReference,
      ]);
    },
    resolveUnknown(input: { operationId: string; actor: string; attemptId: string; evidence: CreditResolutionEvidence }) {
      return operation("SELECT provider_credit.resolve_unknown($1,$2,$3,$4) AS result", [
        input.operationId, input.actor, input.attemptId, input.evidence,
      ]);
    },
    async health(expectedPeriod: string): Promise<ProviderCreditHealth> {
      const result = await call("SELECT provider_credit.health($1) AS result", [expectedPeriod]);
      if (typeof result.initialized !== "boolean" || !nullableString(result.period) ||
          !healthReasons.has(String(result.reason)) || !["ok", "critical", "unavailable"].includes(String(result.severity)) ||
          !integer(result.unresolvedLiabilityTotal) || !integer(result.unresolvedLiabilityCount) ||
          !nullableInteger(result.oldestUnresolvedAgeSeconds) || !integer(result.collectorFloor) ||
          !nullableInteger(result.availableCredits) ||
          (result.reason === "period-mismatch" && result.severity !== "critical") ||
          (!result.initialized && result.availableCredits !== null)) throw new Error("Invalid provider credit health");
      return result as ProviderCreditHealth;
    },
  };
};
