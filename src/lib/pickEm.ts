import type { Pick } from "@/types";

// Multiplies each pick's own probability together -- an Underdog-style
// Pick'em entry only pays out if EVERY leg hits, so this is the right
// operation (product, not sum/average) IF the legs are independent.
// That assumption is the actual gap: this is an INDEPENDENCE ESTIMATE,
// not necessarily the entry's true joint probability -- two legs from
// the same game (e.g. one team's passing yards and rushing yards) can
// be correlated via game script (more rushing usually means less
// passing, and vice versa), which this product ignores entirely.
// Modeling that correlation needs real historical joint-outcome data
// this app doesn't have yet -- until then, callers must label this
// honestly as an estimate, not present it as a precise real number.
// An empty entry is vacuously 1 (100%).
export const computeEntryHitProbability = (picks: Pick[]): number =>
  picks.reduce((joint, pick) => joint * pick.impliedProb, 1);
