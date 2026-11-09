// No application imports precede the parent's cold start. Only durations cross
// IPC; performance.now() values from separate processes are never compared.
let worker, state = "new";
const send = message => process.send?.(message);
process.on("message", async message => {
  try {
    if (message.kind === "initialize" && state === "new") {
      state = "initializing";
      const started = performance.now();
      const { createProducerWorker } = await import("./producer-capacity-worker.ts");
      const importMs = performance.now() - started;
      worker = await createProducerWorker(message.options, statement => send({ kind: "statement", statement }));
      state = "ready";
      send({ kind: "ready", importMs, connectMs: worker.connectMs });
    } else if (message.kind === "live" && state === "ready") {
      state = "live";
      const live = await worker.live();
      state = "pinned";
      send({ kind: "live-complete", live });
    } else if (message.kind === "run" && ["ready", "pinned"].includes(state)) {
      state = "running";
      const result = await worker.run();
      state = "done";
      send({ kind: "result", result });
    } else if (message.kind === "close" && ["ready", "pinned", "done"].includes(state)) {
      state = "closed"; await worker.close(); process.disconnect();
    } else throw new Error("producer-worker-protocol-refused");
  } catch (error) {
    state = "failed";
    send({ kind: "error", error: error instanceof Error ? error.message : "producer-worker-failed",
      sqlState: /^[0-9A-Z]{5}$/.test(error?.code) ? error.code : undefined });
    await worker?.close().catch(() => {});
    process.disconnect();
  }
});
send({ kind: "bootstrap", pid: process.pid });
