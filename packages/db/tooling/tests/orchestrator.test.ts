import { registerOrchestratorDatabaseTest } from "./orchestrator";
import { openTestClient } from "@dfs-ev/db-tooling/test-support/clients";
import { cacheState, freshAfter, key, leaseMs, openContenders, payload, testStore } from "@dfs-ev/db-tooling/test-support/leases";

// Repository integration composes the web-owned scenario with DB-owned fixtures.
registerOrchestratorDatabaseTest<Awaited<ReturnType<typeof openTestClient>>, typeof payload>({
  openTestClient, cacheState, freshAfter, key, leaseMs, payload,
  openContenders: () => openContenders(),
  testStore: (client) => testStore<typeof payload>(client),
});
