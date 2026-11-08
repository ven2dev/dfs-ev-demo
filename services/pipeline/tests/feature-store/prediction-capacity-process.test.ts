import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCapacityProcess } from "../../scripts/feature-store/prediction-capacity-process.ts";
import type { CapacityRequest } from "../../scripts/feature-store/prediction-capacity-workload.ts";

const transport = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: transport.fork }));
const request = { featureId: "f", n: 2, request: {} } as CapacityRequest;
class Worker extends EventEmitter {
  pid = 123; connected = true; stdout = { resume: vi.fn() }; stderr = new EventEmitter();
  send = vi.fn((message: { kind: string }, callback?: (error: Error | null) => void) => {
    if (message.kind === "close") this.emit("exit"); callback?.(null); return true;
  });
  kill = vi.fn(() => { this.connected = false; this.emit("exit"); return true; });
}
describe("#168 authoritative parent process deadline", () => {
  let child: Worker;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    child = new Worker(); transport.fork.mockReset().mockReturnValue(child);
  });
  afterEach(() => vi.useRealTimers());
  const process = (signal?: AbortSignal) => createCapacityProcess({ config: {}, storageRoot: "/private/store", signal });
  const boot = () => { child.emit("spawn"); child.emit("message", { kind: "bootstrap", pid: child.pid }); };
  const result = () => ({ kind: "result", verdict: "pass", pid: child.pid, serialized: '{"status":"available"}',
    importMs: 20, storeMs: 1, connectMs: 5, handlerMs: 10 });
  it("includes spawn/import/connect/serialized receipt in cold total and sends duration, not another clock", async () => {
    const p = process(), pending = p.measure(request, "cold", 1, 0);
    await vi.advanceTimersByTimeAsync(30); boot();
    expect(child.send.mock.calls[0][0]).toMatchObject({ kind: "initialize", remainingMs: 270 });
    expect(child.send.mock.calls[0][0]).not.toHaveProperty("deadlineAt");
    await vi.advanceTimersByTimeAsync(50); child.emit("message", result());
    const sample = await pending;
    expect(sample).toMatchObject({ totalMs: 80, bootstrapMs: 30, startupMs: 56, residualMs: 14, verdict: "pass" });
    child.emit("exit"); await p.close();
    expect(transport.fork).toHaveBeenCalledTimes(1);
  });
  it("latches a deadline during import, kills the worker and ignores a late successful reply", async () => {
    const p = process(), pending = p.measure(request, "cold", 1, 0); boot();
    await vi.advanceTimersByTimeAsync(300); child.emit("message", result());
    const sample = await pending;
    expect(sample.verdict).toBe("fail"); expect(sample.error).toBe("capacity-parent-deadline-exceeded");
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(p.measure(request, "cold", 1, 1)).rejects.toThrow(/terminal/);
    await p.close(); expect(transport.fork).toHaveBeenCalledTimes(1);
  });
  it("captures startup failures and stderr without replacing the sample", async () => {
    const p = process(), pending = p.measure(request, "cold", 1, 0);
    child.stderr.emit("data", "loader failed"); child.emit("error", new Error("spawn-failed"));
    const sample = await pending;
    expect(sample).toMatchObject({ verdict: "fail", stderr: "loader failed" });
    expect(sample.error).toContain("spawn-failed"); await p.close();
  });
  it("abort stops a request before any later message can deliver", async () => {
    const abort = new AbortController(), p = process(abort.signal), pending = p.measure(request, "cold", 1, 0);
    boot(); abort.abort(); child.emit("message", result());
    expect((await pending).error).toBe("capacity-cancelled"); await p.close();
  });
  it("warm setup is separate and one process is reused only within that trial", async () => {
    const p = process(), preparation = p.prepare(); boot();
    await vi.advanceTimersByTimeAsync(80); child.emit("message", { kind: "ready", pid: 123 });
    expect((await preparation).setupMs).toBe(80);
    for (let i = 0; i < 2; i++) {
      const pending = p.measure(request, "warm", 1, i);
      await vi.advanceTimersByTimeAsync(5); child.emit("message", { ...result(), importMs: 0, storeMs: 0, connectMs: .1, handlerMs: 4 });
      expect(await pending).toMatchObject({ startupMs: 0, totalMs: 5, pid: 123 });
    }
    await p.close(); expect(transport.fork).toHaveBeenCalledTimes(1);
  });
  it("reports a startup above 210 without refusing a complete request below 300", async () => {
    const p = process(), pending = p.measure(request, "cold", 1, 0);
    await vi.advanceTimersByTimeAsync(190); boot();
    await vi.advanceTimersByTimeAsync(50); child.emit("message", result());
    expect(await pending).toMatchObject({ verdict: "pass", totalMs: 240, startupMs: 216 });
    child.emit("exit"); await p.close();
  });
  it("refuses reported startup above 300 even when the worker replies before the parent timer", async () => {
    const p = process(), pending = p.measure(request, "cold", 1, 0); boot();
    await vi.advanceTimersByTimeAsync(80);
    child.emit("message", { ...result(), importMs: 294.001 });
    expect(await pending).toMatchObject({ verdict: "fail", error: "capacity-startup-deadline-exceeded" });
    child.emit("exit"); await p.close();
  });
});
