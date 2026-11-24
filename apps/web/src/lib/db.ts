import "server-only";

import { createPgSqlOwner } from "./pgPool.server";
import type { Sql } from "./pgSql";

// Provisional qualification bound, matching A2's two-client proof. Cutover
// selects the deployed maximum from observed limits and I * G * m + H <= B.
// This branch stays unmerged until the real-app PlanetScale Preview passes.
const owner = createPgSqlOwner({ maximum: 2 });

// The owner stays lazy and validates the boundary before every cached reuse.
export const getSql = (): Sql => owner.get();
