import { refuse } from "./validation.ts";

export const TRAINING_TIME_BOUNDS = { preparationMs: 30_000, readMs: 10_000, readinessMs: 30_000 } as const;
// Execution controls are deliberately outside immutable requests and digests.
// Callers can shorten a deadline, never extend the approved operation ceiling.
export type TrainingOperationOptions = { signal?: AbortSignal; deadlineMs?: number };

export const createTrainingOperation = (options: TrainingOperationOptions, ceilingMs: number,
  interruptSession: () => Promise<void>, clock: () => number = () => performance.now()) => {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some((key) => !["signal", "deadlineMs"].includes(key)) ||
      options.signal !== undefined && !(options.signal instanceof AbortSignal)) refuse("training-operation-options-refused");
  const deadlineMs = options.deadlineMs ?? ceilingMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > ceilingMs) refuse("training-operation-options-refused");
  if (options.signal?.aborted) refuse("training-cancelled");
  const deadlineAt = clock() + deadlineMs, controller = new AbortController();
  let failure: Error | null = null, interruption: Promise<void> | null = null;
  const stop = (code: "training-cancelled" | "training-deadline-exceeded") => {
    if (failure) return;
    failure = new Error(code);
    controller.abort(failure);
    // Interrupt and retire the dedicated session. This promise is drained by
    // dispose; cancellation never abandons SQL, file or worker promises.
    interruption = Promise.resolve().then(interruptSession).catch(() => {});
  };
  const cancel = () => stop("training-cancelled");
  const timer = setTimeout(() => stop("training-deadline-exceeded"), deadlineMs);
  timer.unref();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const check = () => {
    if (options.signal?.aborted) cancel();
    // Synchronous parsing can delay timers; a monotonic check still withholds
    // an over-budget result before further work, commit or delivery.
    if (!failure && clock() >= deadlineAt) stop("training-deadline-exceeded");
    if (failure) throw failure;
  };
  const wait = async <T>(work: () => Promise<T>): Promise<T> => {
    check();
    try { const result = await work(); check(); return result; }
    catch (error) { check(); throw error; }
  };
  const dispose = async () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    await interruption;
  };
  return { check, wait, dispose, signal: controller.signal,
    remainingMs: () => { check(); return Math.max(1, Math.ceil(deadlineAt - clock())); } };
};
