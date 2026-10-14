import {createHash} from "node:crypto";
import {gzipSync} from "node:zlib";
import {expect,it} from "vitest";
import {runCompressedWorker,codecSandboxArgs,CODEC_WORKER_MEMORY,CODEC_WORKER_IMAGE} from "../../src/lib/predictive/compressedWorker.ts";
const bytes=()=>gzipSync("private input");
const request=(wire:Uint8Array)=>({feed:"player" as const,season:2026 as const,wireSha256:createHash("sha256").update(wire).digest("hex"),wireBytes:wire.length});
it("fixes the kernel sandbox budget and prohibits network, privilege and daemon logging",()=>{
  expect(CODEC_WORKER_MEMORY).toBe(268435456);
  expect(CODEC_WORKER_IMAGE).toMatch(/^node@sha256:[a-f0-9]{64}$/);
  expect(codecSandboxArgs()).toEqual(["--network=none","--read-only","--log-driver=none","--memory=268435456","--memory-swap=268435456",
    "--pids-limit=32","--cpus=1","--cap-drop=ALL","--security-opt=no-new-privileges","--user=65534:65534","--pull=never"]);
});
it("refuses corrupt wire identity and size before consulting a runtime",async()=>{
  const wire=bytes();
  await expect(runCompressedWorker("inspect",wire,{...request(wire),wireSha256:"0".repeat(64)})).rejects.toThrow("compressed-wire-integrity-failed");
  await expect(runCompressedWorker("inspect",wire,{...request(wire),wireBytes:wire.length+1})).rejects.toThrow("compressed-worker-input-refused");
});
it("rejects invalid capture IDs, deadlines and options before launching",async()=>{
  const wire=bytes();
  await expect(runCompressedWorker("claims",wire,request(wire),{captureId:"\ninvalid"})).rejects.toThrow("source-publication-id-refused");
  for(const deadlineMs of [0,30001,1.5])await expect(runCompressedWorker("inspect",wire,request(wire),{deadlineMs})).rejects.toThrow("compressed-worker-input-refused");
  await expect(runCompressedWorker("inspect",wire,request(wire),{extra:true} as never)).rejects.toThrow("compressed-worker-input-refused");
  for(const limits of [{rows:80001},{decodedBytes:20000001},{rows:0},{rows:1.5},{unknown:1},{constructor:1},null]) {
    await expect(runCompressedWorker("inspect",wire,request(wire),{limits} as never)).rejects.toThrow("compressed-limits-refused");
  }
});
it("rejects pre-cancelled input and unsupported scope without runtime access",async()=>{
  const wire=bytes(),controller=new AbortController();controller.abort();
  await expect(runCompressedWorker("inspect",wire,request(wire),{signal:controller.signal})).rejects.toThrow("compressed-cancelled");
  await expect(runCompressedWorker("inspect",wire,{...request(wire),season:2024 as 2026})).rejects.toThrow("compressed-worker-input-refused");
});
