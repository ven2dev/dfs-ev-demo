import { describe, expect, it, vi } from "vitest";
import { createServerConfig, type ServerInputName } from "./config.server";
const policy = { anonymousNetwork: { intervalMs: 1000, burst: 2 }, signedNetwork: { intervalMs: 1000, burst: 100 }, user: { intervalMs: 1000, burst: 5 } };
const fixture = (overrides: Partial<Record<ServerInputName, string | undefined>> = {}) => {
  const values: Partial<Record<ServerInputName, string | undefined>> = { VERCEL: "1", VERCEL_ENV: "production",
    ODDS_SUBJECT_HMAC_KEYS: JSON.stringify([{ version: "v1", keyHex: "11".repeat(32) }]),
    ODDS_SUBJECT_POLICIES: JSON.stringify(policy), ...overrides };
  const read = vi.fn((name: ServerInputName) => values[name]);return { config: createServerConfig(read), read };
};
describe("#223 explicit configuration with no enforcement default", () => {
  it("no keys or no policies keeps shadow off, no automatic defaults", () => {
    expect(fixture({ ODDS_SUBJECT_HMAC_KEYS: undefined }).config.paidOdds()).toBeNull();
    expect(fixture({ ODDS_SUBJECT_POLICIES: undefined }).config.paidOdds()).toBeNull();
  });
  it("valid configuration is parsed once and never adds an enforce flag", () => {
    const { config, read } = fixture();const first = config.paidOdds();expect(first).not.toBeNull();expect(config.paidOdds()).toBe(first);
    expect(first).not.toHaveProperty("enforce");
    expect(read.mock.calls.filter(([n]) => n === "ODDS_SUBJECT_HMAC_KEYS")).toHaveLength(1);
  });
  it("malformed secret JSON and a tight signed-network policy refuse without reflecting input", () => {
    expect(() => fixture({ ODDS_SUBJECT_HMAC_KEYS: "private-synthetic-invalid" }).config.paidOdds()).toThrow("Application configuration unavailable (invalid).");
    expect(() => fixture({ ODDS_SUBJECT_POLICIES: JSON.stringify({ ...policy, signedNetwork: { intervalMs: 10000, burst: 1 } }) }).config.paidOdds()).toThrow("Application configuration unavailable (invalid).");
  });
});
