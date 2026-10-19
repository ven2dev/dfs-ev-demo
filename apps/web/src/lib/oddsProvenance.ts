import type { OddsDataSource } from "./oddsDataSource";

export const getOddsProvenanceCopy = (dataSource: OddsDataSource | undefined) => {
  if (dataSource === "fixture") {
    return {
      isFixture: true,
      line: "synthetic fixture line, no provider call",
      environment: "After environment adjustment (synthetic fixture weather)",
      history: "synthetic fixture history, not a projection",
      stream: "fixture stream",
      edge: "fixture edge",
      ticks: "fixture ticks recorded",
      waiting: "Waiting for first fixture tick…",
    } as const;
  }

  if (dataSource === "live") {
    return {
      isFixture: false,
      line: "real player-prop line, live Odds API",
      environment: "After environment adjustment (real weather)",
      history: "historical average, not a projection — no predictive model yet",
      stream: "live stream",
      edge: "live edge",
      ticks: "live ticks recorded",
      waiting: "Waiting for first live tick…",
    } as const;
  }

  return {
    isFixture: false,
    line: "awaiting fresh source data",
    environment: "After environment adjustment",
    history: "average, not a projection",
    stream: undefined,
    edge: "edge",
    ticks: "ticks recorded",
    waiting: "Waiting for first tick…",
  } as const;
};
