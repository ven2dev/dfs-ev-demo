import { fork, type ChildProcess } from "node:child_process";
import type { ClientConfig } from "pg";
import type { CapacityRequest } from "./prediction-capacity-workload.ts";
import type { createCapacityWorker } from "./prediction-capacity-worker.ts";
import { capacitySampleDeadlineError } from "./prediction-capacity-evidence.ts";

type WorkerResult = Awaited<ReturnType<Awaited<ReturnType<typeof createCapacityWorker>>["predict"]>>;
export type CapacitySample = Partial<WorkerResult> & { temperature: "cold" | "warm"; trial: number; index: number;
  featureId: string; n: number; verdict: "pass" | "fail"; totalMs: number; pid?: number; error?: string;
  spawnMs: number; bootstrapMs: number; importMs: number; storeMs: number; startupMs: number;
  residualMs: number; stderr: string };
type Message = Partial<WorkerResult> & { kind: string; pid?: number; error?: string; importMs?: number; storeMs?: number; connectMs?: number };
export type CapacityProcessOptions = { config: ClientConfig; storageRoot: string;
  /** Injection for protocol tests only; qualification always uses the default. */
  bootstrap?: URL; signal?: AbortSignal };
const bootstrap = new URL("./prediction-capacity-bootstrap.mjs", import.meta.url);

// The parent is the authoritative full-path clock. A late message cannot turn
// a timed-out sample into success. No retry or replacement process is started.
export const createCapacityProcess = (options: CapacityProcessOptions) => {
  let child: ChildProcess | undefined, stderr = "", pid: number | undefined, terminal = false;
  let pending: ((m: Message) => void) | undefined, exited: Promise<void> | undefined;
  let spawnMs = 0, bootstrapMs = 0, born = 0, autoClose = false;
  const launch = () => {
    born = performance.now();
    child = fork(options.bootstrap ?? bootstrap, [], { execPath: process.execPath, execArgv: [],
      env: { ...process.env, NODE_OPTIONS: "", NODE_COMPILE_CACHE: "", NODE_DISABLE_COMPILE_CACHE: "1" },
      silent: true });
    pid = child.pid;
    child.on("spawn", () => { spawnMs = performance.now() - born; });
    child.stderr?.on("data", data => { stderr = (stderr + String(data)).slice(-8192); });
    // Drain stdout without retaining payload/provider logs in compact receipts.
    child.stdout?.resume();
    child.on("message", message => {
      const m = message as Message;
      if (m.kind === "bootstrap") bootstrapMs = performance.now() - born;
      pending?.(m);
    });
    child.on("error", error => pending?.({ kind: "error", error: String(error) }));
    exited = new Promise(resolve => child!.once("exit", () => {
      pending?.({ kind: "error", error: "capacity-worker-exited-before-result" }); resolve();
    }));
  };
  const exchange = (limit: number, action: (receive: (m: Message) => void) => void,
    receive: (m: Message, finish: (m: Message) => void) => void): Promise<Message> => new Promise(resolve => {
    let settled = false;
    const finish = (m: Message) => {
      if (settled) return; settled = true; pending = undefined;
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort); resolve(m);
    };
    const fail = (reason: string) => { terminal = true; finish({ kind: "error", error: reason }); child?.kill("SIGKILL"); };
    const abort = () => fail("capacity-cancelled");
    const timer = setTimeout(() => fail("capacity-parent-deadline-exceeded"), Math.max(0, limit - performance.now()));
    options.signal?.addEventListener("abort", abort, { once: true });
    pending = m => {
      if (performance.now() >= limit) fail("capacity-parent-deadline-exceeded");
      else if (m.kind === "error") { terminal = true; finish(m); child?.kill("SIGKILL"); }
      else receive(m, finish);
    };
    if (options.signal?.aborted) abort(); else action(pending);
  });
  const send = (message: Parameters<ChildProcess["send"]>[0]) => child!.send(message, error => { if (error) pending?.({ kind: "error", error: String(error) }); });
  return {
    prepare: async () => {
      const start = performance.now();
      const result = await exchange(start + 300, () => launch(), (m, finish) => {
        if (m.kind === "bootstrap") send({ kind: "initialize", config: options.config, storageRoot: options.storageRoot });
        else if (m.kind === "ready") finish(m);
      });
      return { ...result, setupMs: performance.now() - start, spawnMs, bootstrapMs };
    },
    measure: async (input: CapacityRequest, temperature: "cold" | "warm", trial: number, index: number): Promise<CapacitySample> => {
      const start = performance.now(), deadline = start + 300;
      autoClose = temperature === "cold";
      if (terminal) throw new Error("capacity-process-already-terminal");
      const result = await exchange(deadline, () => {
        if (temperature === "cold") launch();
        else send({ kind: "predict", request: input, remainingMs: deadline - performance.now() });
      }, (m, finish) => {
        if (m.kind === "bootstrap") send({ kind: "initialize", config: options.config, storageRoot: options.storageRoot,
          request: input, remainingMs: deadline - performance.now() });
        else if (m.kind === "result") finish(m);
      });
      const totalMs = performance.now() - start;
      const setup = temperature === "cold" ? bootstrapMs + (result.importMs ?? 0) + (result.storeMs ?? 0) + (result.connectMs ?? 0) : 0;
      const values: Partial<Message> = { ...result }; delete values.kind;
      const error = result.error ?? capacitySampleDeadlineError({ totalMs, startupMs: setup });
      return { ...values, temperature, trial, index, featureId: input.featureId, n: input.n,
        verdict: result.verdict === "pass" && !error ? "pass" : "fail", ...(error ? { error } : {}), totalMs,
        pid, spawnMs: temperature === "cold" ? spawnMs : 0, bootstrapMs: temperature === "cold" ? bootstrapMs : 0,
        importMs: result.importMs ?? 0, storeMs: result.storeMs ?? 0, startupMs: setup,
        residualMs: totalMs - setup - (result.handlerMs ?? 0), stderr };
    },
    close: async () => {
      if (!child) return;
      if (child.connected && !autoClose) send({ kind: "close" });
      // Cleanup is outside timing; a broken worker cannot hang the harness.
      const timer = setTimeout(() => child?.kill("SIGKILL"), 500);
      await exited; clearTimeout(timer);
    },
  };
};
