import { registerOrchestratorDatabaseTest } from "../../apps/web/tests/db/orchestrator";
import type { LivePropInputs } from "../../apps/web/src/lib/livePropCacheRepo";
import { openTestClient } from "@dfs-ev/db-tooling/test-support/clients";
import { cacheState, freshAfter, key, leaseMs, openContenders, payload, testStore } from "@dfs-ev/db-tooling/test-support/leases";

// Repository integration composes the web-owned scenario with DB-owned fixtures.
registerOrchestratorDatabaseTest({
  openTestClient, cacheState, freshAfter, key, leaseMs, payload,
  openContenders: () => openContenders<LivePropInputs>(),
  testStore: (client) => testStore<LivePropInputs>(client),
});
