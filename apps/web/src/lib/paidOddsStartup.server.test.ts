import { describe, expect, it, vi } from "vitest";
import { createPaidOddsStartup } from "./paidOddsStartup";
describe("#223 startup capability retry", () => {
  it("missing key/schema is shadow-off, reports once and retries after five seconds", async () => {
    let time = 0, keys = false;
    const query = vi.fn().mockResolvedValue([{ ready: false }]), warn = vi.fn();
    const startup = createPaidOddsStartup({ query, warn, keysConfigured: () => keys, now: () => time });
    expect(await startup.initialize()).toBe("not-installed"); expect(query).not.toHaveBeenCalled();
    keys = true;time = 4999;expect(await startup.initialize()).toBe("not-installed");
    time = 5000;expect(await startup.initialize()).toBe("not-installed");expect(query).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([["not-installed"]]);
    time = 10000;query.mockResolvedValue([{ ready: true }]);expect(await startup.initialize()).toBe("ready");
    expect(await startup.initialize()).toBe("ready");expect(query).toHaveBeenCalledTimes(2);
  });
  it("transient query failure allows caller to remain shadow-off and recovers without restart", async () => {
    let time = 0;const warn = vi.fn();
    const query = vi.fn().mockRejectedValueOnce(new Error("private dependency details")).mockResolvedValue([{ ready: true }]);
    const startup = createPaidOddsStartup({ query, warn, keysConfigured: () => true, now: () => time });
    expect(await Promise.all([startup.initialize(), startup.initialize()])).toEqual(["unavailable", "unavailable"]);
    expect(query).toHaveBeenCalledTimes(1);expect(warn.mock.calls).toEqual([["capability-unavailable"]]);
    time = 5000;expect(await startup.initialize()).toBe("ready");expect(startup.status()).toBe("ready");
  });
});
