import "server-only";
import { readOddsSubjectReport } from "@dfs-ev/db/runtime";
import { getSql } from "./db";
import { initializePaidOdds } from "./paidOddsBoundary";

export const getOddsSubjectReport = async () => {
  if (await initializePaidOdds() !== "ready") return null;
  return readOddsSubjectReport((text, params) => getSql().query(text, params));
};
