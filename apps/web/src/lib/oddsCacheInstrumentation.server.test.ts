import { afterEach, describe, expect, it, vi } from "vitest";

const { initialize } = vi.hoisted(() => ({ initialize: vi.fn() }));
vi.mock("./oddsCacheStartup", () => ({ initializeOddsCache: initialize }));
import { register } from "../instrumentation";
afterEach(() => { vi.unstubAllEnvs(); initialize.mockReset(); });

describe("Next server startup", () => {
  it("awaits the node schema check before readiness", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    let finish!: () => void;
    initialize.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    let ready = false;
    const pending = register().then(() => { ready = true; });
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    expect(ready).toBe(false);
    finish();
    await pending;
    expect(ready).toBe(true);
  });
  it("propagates failed capability checks", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    initialize.mockRejectedValue(new Error("metadata unavailable"));
    await expect(register()).rejects.toThrow("metadata unavailable");
  });
  it("does not import the node database startup on edge", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(initialize).not.toHaveBeenCalled();
  });
});
