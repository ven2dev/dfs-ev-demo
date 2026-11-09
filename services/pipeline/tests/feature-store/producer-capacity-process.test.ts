import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProducerProcess } from "../../scripts/feature-store/producer-capacity-process.ts";
import type { ProducerWorkerOptions } from "../../scripts/feature-store/producer-capacity-worker.ts";

const transport = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: transport.fork }));
class Worker extends EventEmitter {
  pid = 169; connected = true; stdout = { resume: vi.fn() }; stderr = { resume: vi.fn() };
  send = vi.fn((m: { kind: string }, callback?: (error: Error | null) => void) => {
    if (m.kind === "close") this.emit("exit"); callback?.(null); return true;
  });
  kill = vi.fn(() => { this.connected = false; this.emit("exit"); return true; });
}
describe("#169 parent supervision", () => {
  let child: Worker;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    child = new Worker(); transport.fork.mockReset().mockReturnValue(child);
  });
  afterEach(() => vi.useRealTimers());
  const process = (ingestion = true, signal?: AbortSignal) => createProducerProcess({
    worker: { config: {}, sourceRoot: "/originals", destinationRoot: "/new", code: {}, ...(ingestion ? { pin: {} } : {}) } as ProducerWorkerOptions,
    onEvent: vi.fn(), signal,
  });
  const ready = () => {
    child.emit("spawn"); child.emit("message", { kind: "bootstrap" });
    child.emit("message", { kind: "ready", importMs: 10, connectMs: 5, backendPid: 55 });
  };
  const complete = () => child.emit("message", { kind: "result", result: { status: "completed", sql: [], handlerMs: 1 } });
  const live = (status = "completed") => child.emit("message", { kind: "live-complete", live: { status, elapsedMs: 10, error: status === "failed" ? { code: "ingest-http-refused" } : null } });
  it("counts cold spawn/import/connect once in the conservative paired sum", async () => {
    const p = process(), pending = p.measure("cold");
    await vi.advanceTimersByTimeAsync(20); ready();
    await vi.advanceTimersByTimeAsync(40); live(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30); complete();
    expect(await pending).toMatchObject({ totalMs: 90, liveMs: 60, pinnedMs: 30, startupMs: 20, censored: false, backendPid: 55 });
    expect(child.send.mock.calls.map(c => c[0].kind)).toEqual(["initialize", "live", "run"]);
    expect(child.send.mock.calls[0][0]).not.toHaveProperty("deadlineAt");
    await p.close(); expect(transport.fork).toHaveBeenCalledTimes(1);
  });
  it("records warm setup outside timing and refuses reuse/replacement", async () => {
    const p = process(), setup = p.prepare();
    await vi.advanceTimersByTimeAsync(200); ready(); expect((await setup).setupMs).toBe(200);
    const pending = p.measure("warm"); await vi.advanceTimersByTimeAsync(10); live(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20); complete();
    expect(await pending).toMatchObject({ setupMs: 200, startupMs: 0, totalMs: 30 });
    await expect(p.measure("warm")).rejects.toThrow(/state/); await p.close();
  });
  it("kills on the live deadline and ignores late replies without pinned SQL", async () => {
    const p = process(), pending = p.measure("cold"); ready();
    await vi.advanceTimersByTimeAsync(60_000); live(); complete();
    expect(await pending).toMatchObject({ censored: true, error: "producer-capacity-deadline", pinnedMs: 0 });
    expect(child.send.mock.calls.some(c => c[0].kind === "run")).toBe(false);
    await p.close(); expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it("gives pinned ingestion its own deadline and retains its completed live leg", async () => {
    const p = process(), pending = p.measure("cold"); ready();
    await vi.advanceTimersByTimeAsync(1_000); live(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000); complete();
    expect(await pending).toMatchObject({ totalMs: 61_000, liveMs: 1_000, pinnedMs: 60_000,
      censored: true, result: { live: { status: "completed" } } }); await p.close();
  });
  it("failed live observation stops before pinned ingestion, without retry", async () => {
    const p = process(), pending = p.measure("cold"); ready(); live("failed");
    expect(await pending).toMatchObject({ censored: true, error: "ingest-http-refused" });
    expect(child.send.mock.calls.some(c => c[0].kind === "run")).toBe(false); await p.close();
  });
  it("feature timeout and abort cannot be revived by a late success", async () => {
    const p = process(false), pending = p.measure("cold"); ready();
    await vi.advanceTimersByTimeAsync(120_000); complete();
    expect(await pending).toMatchObject({ censored: true, error: "producer-capacity-deadline" }); await p.close();
    child = new Worker(); transport.fork.mockReturnValue(child);
    const signal = new AbortController(), p2 = process(false, signal.signal), second = p2.measure("cold"); ready();
    signal.abort(); complete(); expect(await second).toMatchObject({ censored: true, error: "producer-capacity-aborted" }); await p2.close();
  });
  it("retains process failures and refuses measuring before warm setup", async () => {
    const p = process(); await expect(p.measure("warm")).rejects.toThrow(/state/);
    const pending = p.measure("cold"); child.emit("error", new Error("spawn"));
    expect(await pending).toMatchObject({ censored: true, error: "producer-process-failed" }); await p.close();
  });
});
