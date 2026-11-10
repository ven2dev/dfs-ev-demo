import type { ClientConfig } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProducerWorker } from "../../scripts/feature-store/producer-capacity-worker.ts";

const transport = vi.hoisted(() => ({ construct: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn(), store: vi.fn() }));
vi.mock("pg", () => ({ Client: class {
  constructor(config: unknown) { transport.construct(config); }
  on = vi.fn(); connect = transport.connect; query = transport.query; end = transport.end;
} }));
vi.mock("../../src/featureStore/localObjectStore.ts", () => ({ openLocalObjectStore: transport.store }));

describe("#169 worker target guard", () => {
  const config = (): ClientConfig => ({ host: "127.0.0.1", port: 54329,
    database: "dfs_ev_test_" + "a".repeat(20), user: "fs138_job_" + "b".repeat(16),
    password: "fs138_throwaway", ssl: false });
  const open = (c = config()) => createProducerWorker({ config: c, sourceRoot: "/originals", destinationRoot: "/destination",
    code: { gitSha: "c".repeat(40), contentSha256: "d".repeat(64) } }, vi.fn());
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv("DB_TEST_LANE", undefined);
    transport.connect.mockResolvedValue(undefined); transport.end.mockResolvedValue(undefined);
    transport.store.mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllEnvs());

  // All clients and stores are mocked; these selector tests open no database.
  for (const [selector, port] of [[undefined, 54329], ["default", 54329], ["lane-3", 54349]] as const)
    it(`accepts the selected ${selector ?? "unset default"} port without adding setup SQL`, async () => {
      vi.stubEnv("DB_TEST_LANE", selector);
      const c = { ...config(), port }, worker = await open(c);
      expect(transport.construct).toHaveBeenCalledExactlyOnceWith(c);
      expect(transport.connect).toHaveBeenCalledTimes(1); expect(transport.query).not.toHaveBeenCalled();
      await worker.close(); expect(transport.end).toHaveBeenCalledTimes(1);
    });

  for (const [selector, port] of [[undefined, 54349], ["lane-3", 54329]] as const)
    it(`refuses port ${port} for ${selector ?? "unset default"} before any I/O`, async () => {
      vi.stubEnv("DB_TEST_LANE", selector);
      await expect(open({ ...config(), port })).rejects.toThrow("producer-worker-target-refused");
      expect(transport.construct).not.toHaveBeenCalled(); expect(transport.store).not.toHaveBeenCalled();
    });

  it("refuses an unknown selector before any I/O", async () => {
    vi.stubEnv("DB_TEST_LANE", "unregistered");
    await expect(open()).rejects.toThrow("Unknown DB_TEST_LANE");
    expect(transport.construct).not.toHaveBeenCalled(); expect(transport.store).not.toHaveBeenCalled();
  });
  for (const [name, invalid] of Object.entries({
    "external host": { host: "db.example.test" }, "primary database": { database: "dfs_ev_test" },
    "owner role": { user: "dfs_ev_test" }, "wrong password": { password: "wrong" },
    "TLS override": { ssl: true }, "connection string": { connectionString: "postgresql://unused" },
  } satisfies Record<string, Partial<ClientConfig>>))
    it(`keeps refusing ${name} before any I/O`, async () => {
      await expect(open({ ...config(), ...invalid })).rejects.toThrow("producer-worker-target-refused");
      expect(transport.construct).not.toHaveBeenCalled(); expect(transport.store).not.toHaveBeenCalled();
    });
  it("keeps refusing application credentials before any I/O", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://unused");
    await expect(open()).rejects.toThrow("Application/database credentials");
    expect(transport.construct).not.toHaveBeenCalled(); expect(transport.store).not.toHaveBeenCalled();
  });
});
