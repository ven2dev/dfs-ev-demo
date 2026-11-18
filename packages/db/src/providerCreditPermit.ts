import { createProviderCreditStore, type ProviderCreditReservationInput } from "./providerCredits.ts";

declare const permitBrand: unique symbol;
/** Opaque, process-local authority. Plain objects and serialized copies cannot send. */
export type ProviderCreditPermit = Readonly<ProviderCreditSend> & { readonly [permitBrand]: true; readonly reservationId: string };
export type ProviderCreditSend = {
  sportKey: "americanfootball_nfl"; eventId: string; marketKeys: readonly string[];
  signal?: AbortSignal; deadline: number;
};
type PermitState = ProviderCreditSend & { reservationId: string; authoritative: boolean; now: () => number };
const permits = new WeakMap<ProviderCreditPermit, PermitState>();

/** Only this reservation primitive mints permits, including explicitly non-protective
 * log-only compatibility. Database errors never produce enforce authority. */
export const reserveProviderCreditSend = async (
  store: Pick<ReturnType<typeof createProviderCreditStore>, "reserve">,
  input: ProviderCreditReservationInput,
  send: ProviderCreditSend,
  options: { now?: () => number; onShadowFailure: () => void }
): Promise<ProviderCreditPermit> => {
  const now = options.now ?? (() => performance.now());
  const marketKeys = [...new Set(send.marketKeys)].sort();
  if (input.sportKey !== send.sportKey || (input.kind === "raw" && input.resourceId !== send.eventId) || marketKeys.length < 1 || marketKeys.length > 12 ||
      marketKeys.join(",") !== [...new Set(input.marketKeys)].sort().join(",") ||
      input.expectedCost !== marketKeys.length || !Number.isFinite(send.deadline)) {
    throw new Error("Invalid provider credit send binding");
  }
  const checkLifetime = () => {
    send.signal?.throwIfAborted();
    if (now() >= send.deadline) throw new Error("Provider credit send deadline expired");
  };
  checkLifetime();
  let authoritative = false;
  let outcome: string;
  try {
    const decision = await store.reserve(input);
    outcome = decision.outcome;
    authoritative = decision.allowed;
  } catch {
    if (input.mode === "enforce") throw new Error("Provider credit authority unavailable");
    options.onShadowFailure();
    outcome = "shadow";
  }
  // A committed/replayed reservation never creates another send, in either mode.
  if (!(outcome === "reserved" && authoritative) && !(input.mode === "log-only" && outcome === "shadow")) {
    throw new Error("Provider credit send refused");
  }
  checkLifetime();
  const permit = Object.freeze({ ...send, reservationId: input.id, marketKeys: Object.freeze(marketKeys) }) as ProviderCreditPermit;
  permits.set(permit, { ...send, marketKeys, reservationId: input.id, authoritative, now });
  return permit;
};

/** Consume synchronously immediately before fetch; no await or retry in between. */
export const consumeProviderCreditPermit = (permit: ProviderCreditPermit): Omit<PermitState, "now"> => {
  const state = permits.get(permit);
  if (!state) throw new Error("Invalid or consumed provider credit permit");
  permits.delete(permit);
  state.signal?.throwIfAborted();
  if (state.now() >= state.deadline) throw new Error("Provider credit send deadline expired");
  return { sportKey: state.sportKey, eventId: state.eventId, marketKeys: state.marketKeys,
    signal: state.signal, deadline: state.deadline, reservationId: state.reservationId, authoritative: state.authoritative };
};
