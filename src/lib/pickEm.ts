import type { Pick } from "@/types";

// Joint probability across every pick in the entry, multiplicative not
// additive -- an Underdog-style Pick'em entry only pays out if EVERY
// leg hits, so the entry's real hit probability is the PRODUCT of each
// leg's own probability, not their sum or average. An empty entry is
// vacuously 1 (100%).
export const computeEntryHitProbability = (picks: Pick[]): number =>
  picks.reduce((joint, pick) => joint * pick.impliedProb, 1);
