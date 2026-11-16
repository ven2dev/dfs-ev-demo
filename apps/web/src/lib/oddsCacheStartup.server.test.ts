import { describe, expect, it, vi } from "vitest";
import { createOddsCacheStartup } from "./oddsCacheStartup";

describe("odds-cache startup routing", () => {
  it.each([false, true])("latches schema readiness %s once across concurrent initialization", async (ready) => {
    const query = vi.fn().mockResolvedValue([{ ready }]);
    const startup = createOddsCacheStartup(query);
    const legacy = vi.fn();
    const shared = vi.fn();
    expect(() => startup.select(legacy, shared)).toThrow("has not completed");
    await Promise.all([startup.initialize(), startup.initialize()]);
    expect(startup.select(legacy, shared)).toBe(ready ? shared : legacy);
    // A later DDL change requires a new server instance, not request-time switching.
    query.mockResolvedValue([{ ready: !ready }]);
    await startup.initialize();
    expect(startup.select(legacy, shared)).toBe(ready ? shared : legacy);
    expect(query).toHaveBeenCalledOnce();
  });

  it("keeps database-free local setup on legacy functions", async () => {
    const startup = createOddsCacheStartup();
    await expect(startup.initialize()).resolves.toBe("legacy");
    const legacy = () => "original";
    expect(startup.select(legacy, () => "shared")).toBe(legacy);
  });

  it("refuses readiness on query failure without retry or fallback", async () => {
    const query = vi.fn().mockRejectedValue(new Error("metadata unavailable"));
    const startup = createOddsCacheStartup(query);
    await expect(startup.initialize()).rejects.toThrow("metadata unavailable");
    await expect(startup.initialize()).rejects.toThrow("metadata unavailable");
    expect(query).toHaveBeenCalledOnce();
    expect(() => startup.select(() => 1, () => 2)).toThrow("has not completed");
  });

  it.each([[], [{}], [{ ready: "true" }], [{ ready: null }]].map(rows => ({ rows })))("rejects malformed capability output $rows", async ({ rows }) => {
    const startup = createOddsCacheStartup(vi.fn().mockResolvedValue(rows));
    await expect(startup.initialize()).rejects.toThrow("Invalid odds-cache");
  });
});
