import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCapacityTrial } from "../../scripts/feature-store/prediction-capacity-benchmark.ts";
import { CAPACITY_STARTUP_GATE, type FullCapacityBenchmark } from "../../scripts/feature-store/prediction-capacity-evidence.ts";
import { createCapacityProcess, type CapacitySample } from "../../scripts/feature-store/prediction-capacity-process.ts";
import { CAPACITY_RULES, type CapacityRequest } from "../../scripts/feature-store/prediction-capacity-workload.ts";

const worker = vi.hoisted(() => ({ measure: vi.fn(), close: vi.fn(), prepare: vi.fn() }));
vi.mock("../../scripts/feature-store/prediction-capacity-process.ts", () => ({ createCapacityProcess: vi.fn(() => worker) }));
const options = { config: {}, storageRoot: "/private/store" };
const record = (): FullCapacityBenchmark => ({ kind: "prediction-capacity-benchmark", schemaVersion: 2, issue: 242,
  startupGate: CAPACITY_STARTUP_GATE, step: 2, verdict: "running", controlsOnly: false,
  code: { gitSha: "b".repeat(40), contentSha256: "a".repeat(64) }, codeHashes: {}, codeBlobIds: {},
  manifestSha256: "a".repeat(64), manifestPinnedBeforeTiming: true, samples: [], trials: [], warmSetup: {},
  manifest: { schemaVersion: 1, rules: CAPACITY_RULES, requests: Array.from({ length: 100 }, (_, index) =>
    ({ featureId: `f-${index}`, n: 2, request: {} }) as CapacityRequest) } });
const sample = (index: number, startupMs = 70): CapacitySample => ({ temperature: "cold", trial: 1, index,
  featureId: `f-${index}`, n: 2, pid: index + 1, verdict: "pass", startupMs,
  totalMs: startupMs + Math.min(3, Math.max(0, 300 - startupMs)), spawnMs: 1, bootstrapMs: 20,
  importMs: startupMs - 30, storeMs: 2, connectMs: 8, residualMs: 0, stderr: "" });

describe("#242 actual runner trial boundaries without live timing", () => {
  beforeEach(() => {
    vi.clearAllMocks(); worker.close.mockResolvedValue(undefined); worker.prepare.mockResolvedValue({ kind: "ready" });
    worker.measure.mockImplementation(async (_request, _temperature, _trial, index: number) => sample(index));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  it.each([1, 5])("runs all 100 attempts with %i startup outliers between 210 and 300", async count => {
    const f = record(), saved: number[] = [];
    worker.measure.mockImplementation(async (_r, _t, _n, index: number) => sample(index, index < count ? 240 : 70));
    await runCapacityTrial(f, "C1", options, async () => { saved.push(f.samples.length); });
    expect(f.samples).toHaveLength(100); expect(worker.measure).toHaveBeenCalledTimes(100);
    expect(createCapacityProcess).toHaveBeenCalledTimes(100); expect(worker.close).toHaveBeenCalledTimes(100);
    expect(f.trials[0]).toMatchObject({ pass: true, startupP95Ms: 70, startupMaximumMs: 240 });
    expect(f.trials[0].startupTail).toHaveLength(5); expect(saved).toEqual([...Array.from({ length: 100 }, (_, i) => i + 1), 100]);
  });
  it("persists a failed trial after six slow startups without starting another trial", async () => {
    const f = record(), save = vi.fn(async () => {});
    worker.measure.mockImplementation(async (_r, _t, _n, index: number) => sample(index, index < 6 ? 211 : 70));
    await expect(runCapacityTrial(f, "C1", options, save)).rejects.toThrow(/capacity-trial-missed/);
    expect(f.trials[0]).toMatchObject({ pass: false, startupP95Ms: 211 });
    expect(f.samples).toHaveLength(100); expect(save).toHaveBeenCalledTimes(101);
    expect(worker.measure).toHaveBeenCalledTimes(100); expect(worker.close).toHaveBeenCalledTimes(100);
  });
  it.each([210, 300])("allows an individual startup exactly %s ms", async startupMs => {
    const f = record();
    worker.measure.mockImplementation(async (_r, _t, _n, index: number) => sample(index, index === 0 ? startupMs : 70));
    await runCapacityTrial(f, "C1", options, async () => {});
    expect(f.trials[0].pass).toBe(true); expect(f.samples).toHaveLength(100);
  });
  it.each(["startup", "full-path", "refusal"])("retains a %s miss and stops before another sample", async kind => {
    const f = record(), save = vi.fn(async () => {}), failed = sample(0);
    if (kind === "startup") Object.assign(failed, sample(0, 300.001));
    if (kind === "full-path") failed.totalMs = 300.001;
    if (kind === "refusal") Object.assign(failed, { verdict: "fail", error: "model-current-rights-refused" });
    worker.measure.mockResolvedValue(failed);
    await expect(runCapacityTrial(f, "C1", options, save)).rejects.toThrow(/capacity-sample/);
    expect(f.samples).toEqual([failed]); expect(f.trials).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1); expect(worker.measure).toHaveBeenCalledTimes(1);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });
  it("retains earlier samples alongside a later deadline failure, without replacements", async () => {
    const f = record(), save = vi.fn(async () => {});
    worker.measure.mockImplementation(async (_r, _t, _n, index: number) => sample(index, index === 3 ? 300.001 : 70));
    await expect(runCapacityTrial(f, "C1", options, save)).rejects.toThrow(/capacity-sample-deadline/);
    expect(f.samples.map(s => s.index)).toEqual([0, 1, 2, 3]); expect(save).toHaveBeenCalledTimes(4);
    expect(worker.measure).toHaveBeenCalledTimes(4); expect(worker.close).toHaveBeenCalledTimes(4);
  });
  it("keeps controls unqualified and warm setup outside the measured requests", async () => {
    const f = record(); f.controlsOnly = true;
    worker.measure.mockResolvedValue({ ...sample(0, 0), totalMs: 5, temperature: "warm" });
    await runCapacityTrial(f, "W1", options, async () => {});
    expect(f.warmSetup!.W1).toEqual({ kind: "ready" }); expect(f.trials).toEqual([]);
    expect(f.samples).toHaveLength(1); expect(worker.prepare).toHaveBeenCalledTimes(1);
    expect(createCapacityProcess).toHaveBeenCalledTimes(1); expect(worker.close).toHaveBeenCalledTimes(1);
  });
});
