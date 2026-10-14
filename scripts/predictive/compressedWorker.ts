import { readFile } from "node:fs/promises";
import { inspectCompressedSource, type CompressedInspectionRequest } from "../../src/lib/predictive/compressedSource.ts";
import { prepareCompressedSourceClaims } from "../../src/lib/predictive/compressedClaims.ts";
import { exact, PredictiveError, refuse } from "../../src/lib/predictive/validation.ts";

// Container-only entrypoint. Never trust a requested heap limit as an RSS cap.
try {
  if (!process.version.startsWith("v24.") || await readFile("/sys/fs/cgroup/memory.max", "utf8") !== "268435456\n" ||
      await readFile("/sys/fs/cgroup/memory.swap.max", "utf8") !== "0\n") refuse("compressed-worker-sandbox-refused");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8_004_096) refuse("compressed-worker-input-refused");
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks), newline = input.indexOf(10);
  if (newline < 1 || newline > 4095) refuse("compressed-worker-input-refused");
  const job = JSON.parse(input.subarray(0, newline).toString("utf8"));
  exact(job, ["mode","captureId","request","limits"]);
  if (!["inspect","claims"].includes(job.mode) || (job.mode === "inspect" && job.captureId !== null)) refuse("compressed-worker-input-refused");
  const wire = input.subarray(newline+1), request = job.request as CompressedInspectionRequest;
  const result = job.mode === "inspect" ? await inspectCompressedSource(wire,request,{limits:job.limits}) : await prepareCompressedSourceClaims(job.captureId,wire,request,{limits:job.limits});
  process.stdout.write(JSON.stringify({ ok: true,result,memoryLimitBytes: 268_435_456,peakRssBytes: process.resourceUsage().maxRSS*1024 }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok:false,error:error instanceof PredictiveError ? error.code : "compressed-worker-failed" }));
  process.exitCode=1;
}
