/** Leaf value contracts shared by calculation inputs and consumers. */
export type PlayerPropDirection = "over" | "under";

export type EVScore = {
  modelProb: number;
  impliedProb: number;
  edge: number;
};
