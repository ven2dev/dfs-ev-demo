import "server-only";

import { getSql } from "./db";
import type { OddsApiQuota } from "./oddsApi";

export type OddsApiRequestSource =
  | "slate"
  | "discovery"
  | "live"
  | "scheduled"
  | "direct";

export type OddsApiRequestTelemetry = {
  id: string;
  requestKind: "events" | "event-odds";
  source: OddsApiRequestSource;
  sportKey: string;
  eventId: string | null;
  requestedMarkets: string[];
  requestedAt: Date;
  responseReceivedAt: Date | null;
  outcome: "success" | "http-error" | "network-error" | "aborted";
  httpStatus: number | null;
  quota: OddsApiQuota;
};

const nonEmpty = (value: string, field: string) => {
  if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
};

export const recordOddsApiRequest = async (
  telemetry: OddsApiRequestTelemetry
): Promise<void> => {
  nonEmpty(telemetry.id, "id");
  nonEmpty(telemetry.sportKey, "sportKey");
  if ((telemetry.requestKind === "event-odds") !== (telemetry.eventId !== null)) {
    throw new Error("event-odds telemetry requires eventId; events telemetry forbids it");
  }
  if ((telemetry.requestKind === "event-odds") !== (telemetry.requestedMarkets.length > 0)) {
    throw new Error("event-odds telemetry requires markets; events telemetry forbids them");
  }
  telemetry.requestedMarkets.forEach((market, index) =>
    nonEmpty(market, `requestedMarkets[${index}]`)
  );
  if (telemetry.eventId !== null) nonEmpty(telemetry.eventId, "eventId");
  if (!Number.isFinite(telemetry.requestedAt.getTime())) {
    throw new Error("requestedAt must be a valid date");
  }
  if (
    telemetry.responseReceivedAt !== null &&
    !Number.isFinite(telemetry.responseReceivedAt.getTime())
  ) {
    throw new Error("responseReceivedAt must be a valid date or null");
  }
  if (
    telemetry.responseReceivedAt !== null &&
    telemetry.responseReceivedAt.getTime() < telemetry.requestedAt.getTime()
  ) {
    throw new Error("responseReceivedAt must not precede requestedAt");
  }
  const hasResponse = telemetry.responseReceivedAt !== null;
  if ((telemetry.outcome === "success" || telemetry.outcome === "http-error") !== hasResponse) {
    throw new Error("Telemetry outcome does not match response receipt");
  }
  if (hasResponse !== (telemetry.httpStatus !== null)) {
    throw new Error("Telemetry response receipt and HTTP status must agree");
  }
  if (
    telemetry.httpStatus !== null &&
    (!Number.isInteger(telemetry.httpStatus) ||
      telemetry.httpStatus < 100 ||
      telemetry.httpStatus > 599)
  ) {
    throw new Error("httpStatus must be a valid HTTP status or null");
  }
  for (const [value, field] of [
    [telemetry.quota.remaining, "quota.remaining"],
    [telemetry.quota.used, "quota.used"],
    [telemetry.quota.last, "quota.last"],
  ] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${field} must be a non-negative integer or null`);
    }
  }

  await getSql().query(
    `INSERT INTO odds_api_request_log (
       id, request_kind, source, sport_key, event_id, requested_markets,
       requested_at, response_received_at, outcome, http_status,
       quota_remaining, quota_used, quota_last
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO NOTHING`,
    [
      telemetry.id,
      telemetry.requestKind,
      telemetry.source,
      telemetry.sportKey,
      telemetry.eventId,
      telemetry.requestedMarkets,
      telemetry.requestedAt.toISOString(),
      telemetry.responseReceivedAt?.toISOString() ?? null,
      telemetry.outcome,
      telemetry.httpStatus,
      telemetry.quota.remaining,
      telemetry.quota.used,
      telemetry.quota.last,
    ]
  );
};
