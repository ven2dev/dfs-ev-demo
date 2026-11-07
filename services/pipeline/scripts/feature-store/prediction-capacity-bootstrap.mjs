// Deliberately no application imports before the parent's cold clock starts.
// Durations cross IPC; absolute performance.now() clocks never cross processes.
let worker;
process.on("message", async message => {
  const received = performance.now();
  try {
    if (message.kind === "initialize") {
      const beforeImport = performance.now();
      const { createCapacityWorker } = await import("./prediction-capacity-worker.ts");
      const importMs = performance.now() - beforeImport;
      worker = await createCapacityWorker(message.config, message.storageRoot);
      if (message.request) {
        const result = await worker.predict(message.request, received + message.remainingMs);
        process.send?.({ kind: "result", ...result, importMs, storeMs: worker.storeMs, pid: process.pid });
        await worker.close(); process.disconnect();
      } else {
        const connectMs = await worker.prepare();
        process.send?.({ kind: "ready", importMs, storeMs: worker.storeMs, connectMs, pid: process.pid });
      }
    } else if (message.kind === "predict" && worker) {
      const result = await worker.predict(message.request, received + message.remainingMs);
      process.send?.({ kind: "result", ...result, importMs: 0, storeMs: 0, pid: process.pid });
    } else if (message.kind === "close" && worker) {
      await worker.close(); process.disconnect();
    } else throw new Error("invalid-capacity-protocol");
  } catch (error) {
    process.send?.({ kind: "error", error: String(error), pid: process.pid });
    await worker?.close().catch(() => {}); process.disconnect();
  }
});
process.send?.({ kind: "bootstrap", pid: process.pid });
