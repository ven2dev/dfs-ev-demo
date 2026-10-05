import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { bootstrapTestDatabase, closeTestClients, resetLivePropCache } from "./harness";

beforeAll(bootstrapTestDatabase);
beforeEach(resetLivePropCache);
afterEach(closeTestClients);
afterAll(closeTestClients);
