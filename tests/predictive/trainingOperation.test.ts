import { expect, it } from "vitest";
import { createTrainingOperation, TRAINING_TIME_BOUNDS } from "../../src/lib/predictive/trainingOperation.ts";
import { trainingInvalidationFailure } from "../../src/lib/predictive/trainingInvalidation.ts";

it("refuses extended deadlines and pre-cancellation without interrupting a session", () => {
  let interruptions = 0;
  const interrupt = async () => { interruptions++; };
  for (const options of [{ deadlineMs: 10_001 }, { deadlineMs: 0 }, { deadlineMs: 1.5 }, { certificate: true }]) {
    expect(() => createTrainingOperation(options, TRAINING_TIME_BOUNDS.readMs, interrupt)).toThrow("training-operation-options-refused");
  }
  const controller = new AbortController(); controller.abort(new Error("private reason"));
  expect(() => createTrainingOperation({ signal: controller.signal }, 10_000, interrupt)).toThrow("training-cancelled");
  expect(interruptions).toBe(0);
});

it("charges all phases to one monotonic deadline and refuses delayed synchronous delivery", async () => {
  let clock = 0, interruptions = 0;
  const operation = createTrainingOperation({ deadlineMs: 100 }, 10_000, async () => { interruptions++; }, () => clock);
  try {
    expect(await operation.wait(async () => { clock = 60; return "phase one"; })).toBe("phase one");
    expect(operation.remainingMs()).toBe(40);
    await expect(operation.wait(async () => { clock = 100; return "late payload"; })).rejects.toThrow("training-deadline-exceeded");
    expect(operation.signal.aborted).toBe(true);
    expect(trainingInvalidationFailure(operation.signal.reason)).toBeNull();
    let entered = false;
    await expect(operation.wait(async () => { entered = true; })).rejects.toThrow("training-deadline-exceeded");
    expect(entered).toBe(false);
  } finally { await operation.dispose(); }
  expect(interruptions).toBe(1);
});

it("cancels in-flight work without detaching it or exposing the caller's reason", async () => {
  const caller = new AbortController(); let interruptions = 0, finish!: () => void;
  const operation = createTrainingOperation({ signal: caller.signal }, 10_000, async () => { interruptions++; });
  const work = new Promise<string>((resolve) => { finish = () => resolve("protected payload"); });
  const running = operation.wait(() => work);
  const settled = running.then(() => "delivered", (error: Error) => error.message);
  caller.abort(new Error("private path and provider text"));
  expect(operation.signal.reason.message).toBe("training-cancelled");
  let completed = false; void settled.then(() => { completed = true; });
  await Promise.resolve(); expect(completed).toBe(false);
  finish();
  expect(await settled).toBe("training-cancelled");
  await operation.dispose(); expect(interruptions).toBe(1);
});

it("interrupts a blocked statement at the deadline and drains its rejection", async () => {
  let reject!: (error: Error) => void, interruptions = 0;
  const blocked = new Promise<never>((_, fail) => { reject = fail; });
  const operation = createTrainingOperation({ deadlineMs: 20 }, 10_000, async () => {
    interruptions++; reject(new Error("Connection terminated"));
  });
  try { await expect(operation.wait(() => blocked)).rejects.toThrow("training-deadline-exceeded"); }
  finally { await operation.dispose(); }
  expect(interruptions).toBe(1);
});

it("removes the caller listener and timer after successful completion", async () => {
  const caller = new AbortController(); let interruptions = 0;
  const operation = createTrainingOperation({ signal: caller.signal, deadlineMs: 50 }, 10_000, async () => { interruptions++; });
  expect(await operation.wait(async () => "complete")).toBe("complete");
  await operation.dispose(); caller.abort();
  expect(interruptions).toBe(0);
});
