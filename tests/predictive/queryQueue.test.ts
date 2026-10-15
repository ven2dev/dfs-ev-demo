import { expect, it } from "vitest";
import { createQueryQueue } from "../../src/lib/predictive/queryQueue.ts";
import { createTrainingOperation } from "../../src/lib/predictive/trainingOperation.ts";

it("serializes independent query branches and runs cleanup only after every submitted statement settles", async () => {
  const queue = createQueryQueue(), events: string[] = [];
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  const first = queue.run(async () => { events.push("first starts"); await blocked; events.push("first ends"); });
  const second = queue.run(async () => { events.push("second"); throw new Error("statement-failed"); });
  const settled = Promise.allSettled([first, second]);
  const cleanup = queue.run(async () => { events.push("rollback"); });
  await Promise.resolve();
  expect(events).toEqual(["first starts"]);
  finish();
  expect((await settled)[1]).toMatchObject({ status: "rejected", reason: { message: "statement-failed" } });
  await cleanup;
  expect(events).toEqual(["first starts", "first ends", "second", "rollback"]);
  expect(await queue.run(async () => "recovered session")).toBe("recovered session");
});

it("charges queued work to its original deadline and never submits it after cancellation", async () => {
  const queue = createQueryQueue(), controller = new AbortController(), submitted: number[] = [];
  let finish!: () => void, interruptions = 0;
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  const operation = createTrainingOperation({ signal: controller.signal }, 10_000, async () => { interruptions++; finish(); });
  const first = queue.run(() => operation.wait(async () => { submitted.push(1); await blocked; }));
  const second = queue.run(() => operation.wait(async () => { submitted.push(2); }));
  const settled = Promise.allSettled([first, second]);
  await Promise.resolve();
  expect(submitted).toEqual([1]);
  controller.abort();
  const results = await settled;
  expect(results.every((result) => result.status === "rejected" && result.reason.message === "training-cancelled")).toBe(true);
  expect(submitted).toEqual([1]);
  await operation.dispose();
  expect(interruptions).toBe(1);
});
