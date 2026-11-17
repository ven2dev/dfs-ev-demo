import { afterEach, describe, expect, it, vi } from "vitest";

const { initialize } = vi.hoisted(() => ({ initialize: vi.fn() }));
vi.mock("./oddsCacheStartup", () => ({ initializeOddsCache: initialize }));
import { register } from "../instrumentation";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); initialize.mockReset(); });

describe("Next server startup dependency isolation", () => {
  it("lets unrelated routes become ready while the odds check is still pending", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const check = Promise.withResolvers<void>();
    initialize.mockReturnValue(check.promise);
    await expect(register()).resolves.toBeUndefined();
    expect(initialize).toHaveBeenCalledOnce();
    check.resolve();
  });
  it("handles a failed odds preflight without rejecting global registration", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    initialize.mockRejectedValue(new Error("metadata unavailable"));
    await expect(register()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    expect(log.mock.calls[0]).toEqual(["[odds-cache] capability check unavailable; odds requests remain gated until retry"]);
  });
  it("does not import node database startup on edge", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(initialize).not.toHaveBeenCalled();
  });
});
