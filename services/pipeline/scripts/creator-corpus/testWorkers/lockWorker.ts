// Child process for the multi-process lock tests. Not part of the tools: it
// exists so the tests can run real, separate processes against one lock, and
// is started only by those tests. It waits for a "go" file so every worker
// contends at the same moment.
import { appendFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCaptureStore } from "../captureStore.ts";
import { withPrivateFileLock } from "../privateOutput.ts";

const [mode, target, go, shared, extra] = process.argv.slice(2) as [string, string, string, string, string?];

const exists = (path: string) => stat(path).then(() => true, () => false);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
while (!(await exists(go))) await sleep(2);

if (mode === "section") {
  // Inside the lock: claim a marker file exclusively, read-modify-write a
  // counter slowly, release the marker. Two workers inside at once either
  // fail to claim the marker or lose a counter update.
  const marker = join(shared, "inside.marker");
  const counter = join(shared, "counter.txt");
  await withPrivateFileLock(
    target,
    async () => {
      try {
        await writeFile(marker, String(process.pid), { flag: "wx" });
      } catch {
        await appendFile(join(shared, "violations.txt"), `${process.pid}\n`);
      }
      const before = Number(await readFile(counter, "utf8"));
      await sleep(15);
      await writeFile(counter, String(before + 1));
      await rm(marker, { force: true });
    },
    { timeoutMs: 30_000 }
  );
  console.log("done");
} else if (mode === "try") {
  // Wait only briefly and report how it ended, for contenders that must not get in.
  try {
    await withPrivateFileLock(target, async () => undefined, { timeoutMs: 1500 });
    console.log("entered");
  } catch (error) {
    console.log((error as { code?: string }).code ?? "error");
  }
} else if (mode === "capture") {
  const discovery = JSON.parse(await readFile(join(shared, "discovery.json"), "utf8"));
  const store = createCaptureStore({ path: target, discovery, now: () => new Date(extra as string), lock: { timeoutMs: 30_000 } });
  try {
    await store.append({
      creatorKey: "creator-a",
      videoId: "vid00000001",
      action: "capture",
      text: "0:00 a synthetic transcript line for the lock test. ".repeat(10),
      publishedDate: "2025-10-09",
    });
    console.log("accepted");
  } catch (error) {
    console.log((error as { code?: string }).code ?? "error");
  }
}
