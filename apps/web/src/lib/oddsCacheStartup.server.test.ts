import { describe, expect, it, vi } from "vitest";
import { createOddsCacheStartup } from "./oddsCacheStartup";

describe("odds-cache startup routing", () => {
  it("status reads never initialize, query or retry a dependency", async () => {
    let now = 0;
    const query = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue([{ ready: true }]);
    const startup = createOddsCacheStartup(query, () => now);
    expect(startup.status()).toBe("not-initialized");expect(query).not.toHaveBeenCalled();
    await expect(startup.initialize()).rejects.toThrow("unavailable");
    expect(startup.status()).toBe("unavailable");
    now = 5000;
    expect(startup.status()).toBe("unavailable");expect(query).toHaveBeenCalledTimes(1);
    await startup.initialize();
    expect(startup.status()).toBe("shared");expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("latches verified readiness %s across concurrent initialization and selection", async ready => {
    const query = vi.fn().mockResolvedValue([{ ready }]);
    const startup = createOddsCacheStartup(query);
    const legacy = vi.fn(), shared = vi.fn();
    const paths = await Promise.all([startup.select(legacy, shared), startup.select(legacy, shared)]);
    expect(paths).toEqual([ready ? shared : legacy, ready ? shared : legacy]);
    // Successful schema decisions still require a restart to change.
    query.mockResolvedValue([{ ready: !ready }]);
    await startup.initialize();
    expect(await startup.select(legacy, shared)).toBe(ready ? shared : legacy);
    expect(query).toHaveBeenCalledOnce();
  });

  it("keeps database-free setup on verified legacy functions", async () => {
    const startup = createOddsCacheStartup();
    const legacy = () => "original";
    expect(await startup.select(legacy, () => "shared")).toBe(legacy);
  });

  it("refuses without fallback, then retries the next use after 5 seconds without a restart", async () => {
    let now = 0;
    const query = vi.fn().mockRejectedValueOnce(new Error("metadata unavailable")).mockResolvedValue([{ ready: true }]);
    const startup = createOddsCacheStartup(query, () => now);
    const legacy = vi.fn(), shared = vi.fn();
    await expect(startup.initialize()).rejects.toThrow("metadata unavailable");
    await expect(startup.select(legacy, shared)).rejects.toThrow("metadata unavailable");
    now = 4_999;
    await expect(startup.initialize()).rejects.toThrow("metadata unavailable");
    expect(query).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    expect(shared).not.toHaveBeenCalled();
    now = 5_000;
    const results = await Promise.all([startup.select(legacy, shared), startup.select(legacy, shared), startup.initialize()]);
    expect(results).toEqual([shared, shared, "shared"]);
    expect(query).toHaveBeenCalledTimes(2);
    now = 10_000;
    expect(await startup.select(legacy, shared)).toBe(shared);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("backs off repeated failures from each failure, without extending the wait on refused uses", async () => {
    let now = 0;
    const query = vi.fn().mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure")).mockResolvedValue([{ ready: false }]);
    const startup = createOddsCacheStartup(query, () => now);
    await expect(startup.initialize()).rejects.toThrow("first failure");
    now = 5_000;
    await expect(startup.initialize()).rejects.toThrow("second failure");
    now = 9_999;
    await expect(startup.initialize()).rejects.toThrow("second failure");
    now = 10_000;
    await expect(startup.initialize()).resolves.toBe("legacy"); // Valid schema result, never a failure fallback.
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each([[], [{}], [{ ready: "true" }], [{ ready: null }]].map(rows => ({ rows })))("refuses malformed output $rows", async ({ rows }) => {
    const startup = createOddsCacheStartup(vi.fn().mockResolvedValue(rows));
    await expect(startup.initialize()).rejects.toThrow("Invalid odds-cache");
  });
});
