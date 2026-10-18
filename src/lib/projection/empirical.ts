/**
 * Equal-mass empirical math only. Callers qualify observations and sample policy;
 * rights, timestamps, market rules and calibration claims belong to adapters.
 */
export type SupportPoint = { value: number; mass: number };
export type Triple = { overProbability: number; underProbability: number; pushProbability: number };

export const equalMassSupport = (values: readonly number[]): SupportPoint[] => {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a - b)
    .map(([value, count]) => ({ value, mass: count / values.length }));
};

export const validateTriple = (p: Triple): void => {
  const values = [p.overProbability, p.underProbability, p.pushProbability];
  if (values.some(v => !Number.isFinite(v) || v < 0 || v > 1) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-12) throw new Error("invalid probability triple");
};

/** Null support represents unavailable input; invalid lines still refuse first. */
export const probabilityAt = (support: readonly SupportPoint[] | null, line: number): Triple | null => {
  if (!Number.isFinite(line)) throw new Error("line must be finite");
  if (support === null) return null;
  let underMass = 0, pushMass = 0, totalMass = 0;
  for (const point of support) {
    totalMass += point.mass;
    if (point.value < line) underMass += point.mass;
    if (point.value === line) pushMass += point.mass;
  }
  const underProbability = underMass / totalMass;
  const pushProbability = pushMass / totalMass;
  const p = { underProbability, pushProbability, overProbability: Math.max(0, 1 - underProbability - pushProbability) };
  validateTriple(p);
  return p;
};

/** Unit stake, decimal price, equality refunded. Voids/DNP are outside this contract. */
export const priceSide = (p: Triple, side: "over" | "under", decimalPrice?: number) => {
  validateTriple(p);
  if (decimalPrice !== undefined && (!Number.isFinite(decimalPrice) || decimalPrice <= 1)) throw new Error("invalid decimal price");
  const win = side === "over" ? p.overProbability : p.underProbability;
  const loss = side === "over" ? p.underProbability : p.overProbability;
  return {
    noPushConditionalProbability: p.pushProbability === 1 ? null : win / (1 - p.pushProbability),
    fairDecimalPrice: win === 0 ? null : (win + loss) / win,
    expectedProfit: decimalPrice === undefined ? null : win * (decimalPrice - 1) - loss,
  };
};
