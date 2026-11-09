import { fork, type ChildProcess } from "node:child_process";
import type { ProducerWorkerOptions } from "./producer-capacity-worker.ts";
import type { LiveDownloadReceipt } from "./live-download.ts";
import type { ProcessMeasurement, StatementTime, WorkerResult } from "./producer-capacity-contract.ts";

type Message = { kind: string; error?: string; sqlState?: string; pid?: number; backendPid?: number; importMs?: number; connectMs?: number;
  live?: LiveDownloadReceipt; result?: WorkerResult; statement?: StatementTime };
type Options = { worker: ProducerWorkerOptions; signal?: AbortSignal;
  onEvent: (message: Message) => void;
  /** Protocol tests only. Qualification uses the standard bootstrap/deadlines. */
  bootstrap?: URL; deadlines?: { ingestion: number; features: number; setup: number } };

export const createProducerProcess = (options: Options) => {
  const limits = options.deadlines ?? { ingestion: 60_000, features: 120_000, setup: 60_000 };
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, pending: ((m: Message) => void) | undefined;
  let terminal = false, prepared = false, used = false, born = 0, spawnMs = 0, bootstrapMs = 0, importMs = 0, connectMs = 0, setupMs = 0;
  let pid: number | undefined, backendPid: number | undefined, lastError: string | undefined, sqlState: string | undefined, readyMs = 0;
  const send = (m: object) => child!.send(m, error => { if (error) pending?.({ kind: "error", error: "producer-ipc-failed" }); });
  const launch = () => {
    born = performance.now();
    child = fork(options.bootstrap ?? new URL("./producer-capacity-bootstrap.mjs", import.meta.url), [], {
      execPath: process.execPath, execArgv: [], silent: true,
      env: { ...process.env, NODE_OPTIONS: "", NODE_COMPILE_CACHE: "", NODE_DISABLE_COMPILE_CACHE: "1" },
    });
    pid = child.pid;
    child.once("spawn", () => { spawnMs = performance.now() - born; });
    child.stdout?.resume(); child.stderr?.resume();
    child.on("message", m => pending?.(m as Message));
    child.on("error", () => pending?.({ kind: "error", error: "producer-process-failed" }));
    exited = new Promise(resolve => child!.once("exit", () => {
      pending?.({ kind: "error", error: "producer-process-exited" }); resolve();
    }));
  };
  const exchange = (deadline: number, start: () => void, accept: (m: Message) => boolean): Promise<Message> => new Promise(resolve => {
    let settled = false;
    const finish = (m: Message) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); pending = undefined;
      resolve(m);
    };
    const fail = (error: string) => { terminal = true; lastError = error; finish({ kind: "error", error }); child?.kill("SIGKILL"); };
    const abort = () => fail("producer-capacity-aborted");
    const timer = setTimeout(() => fail("producer-capacity-deadline"), Math.max(0, deadline - performance.now()));
    pending = m => {
      if (performance.now() > deadline) return fail("producer-capacity-deadline");
      options.onEvent(m);
      if (m.kind === "error") { sqlState = m.sqlState; return fail(m.error ?? "producer-capacity-failed"); }
      if (m.kind === "statement") return;
      if (accept(m)) finish(m);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort(); else start();
  });
  const initialize = (m: Message) => {
    if (m.kind === "bootstrap") { bootstrapMs = performance.now() - born; send({ kind: "initialize", options: options.worker }); }
    if (m.kind === "ready") { readyMs = performance.now() - born; importMs = m.importMs ?? 0; connectMs = m.connectMs ?? 0; backendPid = m.backendPid; prepared = true; }
  };
  return {
    prepare: async () => {
      if (child || terminal) throw new Error("producer-process-state-refused");
      const started = performance.now();
      const result = await exchange(started + limits.setup, launch, m => { initialize(m); return m.kind === "ready"; });
      setupMs = performance.now() - started;
      if (result.kind === "error") throw new Error(result.error);
      return { setupMs, pid, backendPid, importMs, connectMs, spawnMs, bootstrapMs };
    },
    measure: async (temperature: "cold" | "warm"): Promise<ProcessMeasurement> => {
      if (terminal || used || (temperature === "cold" ? !!child : !prepared)) throw new Error("producer-process-state-refused");
      used = true;
      const started = performance.now(), ingestion = !!options.worker.pin;
      let live: LiveDownloadReceipt | undefined, liveMs = 0, boundary = started;
      const first = await exchange(started + (ingestion ? limits.ingestion : limits.features), () => {
        if (temperature === "cold") launch(); else send({ kind: ingestion ? "live" : "run" });
      }, m => {
        initialize(m);
        if (m.kind === "ready") send({ kind: ingestion ? "live" : "run" });
        return m.kind === (ingestion ? "live-complete" : "result");
      });
      let result = first;
      if (ingestion && first.kind === "live-complete") {
        boundary = performance.now(); liveMs = boundary - started; live = first.live;
        if (live?.status !== "completed") { terminal = true; lastError = live?.error?.code ?? "producer-live-failed"; child?.kill("SIGKILL"); }
        else result = await exchange(boundary + limits.ingestion, () => send({ kind: "run" }), m => m.kind === "result");
      }
      const totalMs = performance.now() - started;
      if (ingestion && !live) liveMs = totalMs;
      if (result.result && live) result.result.live = live;
      const error = lastError ?? result.error;
      terminal = true;
      return { totalMs, liveMs, pinnedMs: ingestion && live ? totalMs - liveMs : 0,
        startupMs: temperature === "cold" ? readyMs : 0,
        spawnMs, bootstrapMs, importMs, connectMs, setupMs, pid, backendPid,
        censored: !!error, ...(error ? { error, sqlState } : {}),
        ...(result.result ? { result: result.result } : live ? { result: { status: "failed", live, sql: [], handlerMs: 0 } as WorkerResult } : {}) };
    },
    close: async () => {
      if (!child || !exited) return;
      if (child.connected && !lastError) send({ kind: "close" });
      const timer = setTimeout(() => child?.kill("SIGKILL"), 500);
      await exited; clearTimeout(timer);
    },
  };
};
