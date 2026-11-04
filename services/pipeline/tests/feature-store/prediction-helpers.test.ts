import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { validateModelDescriptor, PredictionValidationError, type PredictionValidationCode,
  type PredictionRequestPins } from "../../src/featureStore/predictionHelpers.ts";
import { predictionFixture } from "./prediction-helpers-fixture.ts";

const strict = "strict-point-in-time-v1", retro = "retrospective-reconstruction-v1";
type Input = ReturnType<typeof predictionFixture>;
const refuses = (input: Input, code: PredictionValidationCode = "descriptor-mismatch") => {
  try { validateModelDescriptor(input); expect.fail("expected private validation refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(PredictionValidationError);
    expect(error).toMatchObject({ code, message: code });
  }
};
const freeze = (value: unknown): void => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
};

describe("#235 private descriptor compatibility", () => {
  it.each([[strict], [retro], [strict, retro], [retro, strict]] as const)("accepts the actual publisher/Q1 projection for modes %j", (...modes) => {
    const input = predictionFixture(modes), result = validateModelDescriptor(input);
    expect(result).toEqual({ runId: input.model.run.runId, descriptorSha256: input.model.run.descriptorSha256,
      rightsScope: "research", designation: "uncalibrated-interim-hit-rate",
      modelVersion: input.supported.modelVersion, featureVersion: input.supported.featureVersion,
      labelVersion: input.supported.labelVersion, historyPolicy: input.supported.historyPolicy,
      scoringPolicy: input.supported.scoringPolicy, adapter: input.supported.adapter,
      evidenceMode: input.request.evidenceMode, datasetModes: [...modes].sort() });
    expect(result).not.toHaveProperty("identity"); expect(result).not.toHaveProperty("datasets");
  });
  it("compares dataset sets independent of array/object order, with no JSON serialization", () => {
    const input = predictionFixture(); input.descriptor.datasets.reverse();
    input.descriptor.identity.code = { contentSha256: input.model.run.identity.code.contentSha256,
      gitSha: input.model.run.identity.code.gitSha };
    const expected = validateModelDescriptor(input);
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw new Error("unexpected-serialization"); });
    let result;
    try { result = validateModelDescriptor(input); } finally { stringify.mockRestore(); }
    expect(result).toEqual(expected);
  });
  it("allows the same UUID with different letter case but never a different run", () => {
    const input = predictionFixture(); input.request = { ...input.request, runId: input.request.runId.toUpperCase() };
    expect(validateModelDescriptor(input).runId).toBe(input.model.run.runId);
    input.request = { ...input.request, runId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }; refuses(input);
  });
  it.each([null, [], "descriptor", 1, {}, { format: "qb-model-descriptor-v1" }])("refuses malformed descriptor %j", descriptor => {
    refuses({ ...predictionFixture(), descriptor } as Input);
  });
  it.each(["format", "rightsScope"] as const)("refuses wrong descriptor %s", key => {
    const input = predictionFixture(); input.descriptor[key] = "unknown"; refuses(input);
  });
  it.each(["format", "designation"] as const)("refuses wrong identity %s even if recorded", key => {
    const input = predictionFixture(); input.descriptor.identity[key] = "unknown"; input.model.run.identity[key] = "unknown"; refuses(input);
  });
  it.each(["modelVersion", "featureVersion", "historyPolicy", "scoringPolicy"] as const)("refuses unsupported requested %s", key => {
    const input = predictionFixture(); input.request = { ...input.request, [key]: "unknown" } as PredictionRequestPins;
    refuses(input, "unsupported-model-policy");
  });
  it.each(["modelVersion", "featureVersion", "labelVersion", "historyPolicy", "scoringPolicy"] as const)("refuses unsupported recorded %s without fallback", key => {
    const input = predictionFixture(); input.model.run.identity[key] = "unknown"; input.descriptor.identity[key] = "unknown";
    refuses(input, "unsupported-model-policy");
  });
  it.each(["id", "version"] as const)("refuses unsupported recorded adapter %s", key => {
    const input = predictionFixture(); input.model.run.identity.adapter = { ...input.model.run.identity.adapter, [key]: "unknown" };
    input.descriptor.identity.adapter = { ...input.descriptor.identity.adapter, [key]: "unknown" };
    refuses(input, "unsupported-model-policy");
  });
  it("refuses an unknown requested evidence mode", () => {
    const input = predictionFixture(); input.request = { ...input.request, evidenceMode: "unknown" } as unknown as PredictionRequestPins;
    refuses(input, "unsupported-model-policy");
  });
  it.each(["gitSha", "contentSha256"] as const)("compares full immutable identity, including code %s", key => {
    const input = predictionFixture(); input.descriptor.identity.code[key] = "0".repeat(key === "gitSha" ? 40 : 64); refuses(input);
  });
  it.each(["commit", "path", "sha256"] as const)("compares preregistration %s to Q1", key => {
    const input = predictionFixture(); input.descriptor.identity.preregistration = { ...input.descriptor.identity.preregistration, [key]: "different" };
    refuses(input);
  });
  it("distinguishes a changed descriptor claim from a matching-but-unsupported model", () => {
    const input = predictionFixture(); input.descriptor.identity.modelVersion = "unknown"; refuses(input);
    input.model.run.identity.modelVersion = "unknown"; refuses(input, "unsupported-model-policy");
  });
  it.each(["datasetId", "mode", "fileSha256", "contentSha256", "rowCount"] as const)("refuses mismatched dataset %s", key => {
    const input = predictionFixture(); const pin = input.descriptor.datasets[0];
    if (key === "rowCount") pin.rowCount++;
    else if (key === "mode") pin.mode = retro;
    else pin[key] = key === "datasetId" ? "99999999-9999-9999-9999-999999999999" : "0".repeat(64);
    refuses(input);
  });
  it.each(["mode", "featureVersion", "labelVersion", "historyPolicy", "featuresAsOf", "labelsAsOf", "includeRetrospective", "includeSuperseded"] as const)("compares exact dataset spec %s", key => {
    const input = predictionFixture(), spec = input.descriptor.datasets[0].spec;
    input.descriptor.datasets[0].spec = { ...spec, [key]: typeof spec[key] === "boolean" ? !spec[key] : "different" } as typeof spec;
    refuses(input);
  });
  it.each(["empty", "missing", "extra", "duplicate", "same-id", "same-mode", "null-entry"] as const)("refuses %s descriptor dataset pins", kind => {
    const input = predictionFixture(), pins = input.descriptor.datasets;
    if (kind === "empty") pins.length = 0;
    else if (kind === "missing") pins.pop();
    else if (kind === "extra") pins.push(structuredClone(pins[0]));
    else if (kind === "duplicate") pins[1] = structuredClone(pins[0]);
    else if (kind === "same-id") pins[1].datasetId = pins[0].datasetId;
    else if (kind === "same-mode") pins[1].mode = pins[0].mode;
    else pins[0] = null as unknown as typeof pins[0];
    refuses(input);
  });
  it.each(["empty", "extra", "duplicate-id", "duplicate-mode"] as const)("refuses inconsistent Q1 %s set", kind => {
    const input = predictionFixture(), pins = input.model.datasets;
    if (kind === "empty") pins.length = 0;
    else if (kind === "extra") pins.push(structuredClone(pins[0]));
    else if (kind === "duplicate-id") pins[1].datasetId = pins[0].datasetId;
    else pins[1].mode = pins[0].mode;
    refuses(input);
  });
  it.each(["playerId", "gameId", "featureVersion", "historyPolicy", "evidenceMode"] as const)("refuses context %s confusion at either projection", key => {
    for (const section of ["request", "feature"] as const) {
      const input = predictionFixture(); Object.assign(input.context[section], { [key]: "other" }); refuses(input);
    }
  });
  it.each([{ runId: "latest" }, { playerId: "" }, { gameId: " " }])("refuses malformed request %j", patch => {
    const input = predictionFixture(); input.request = { ...input.request, ...patch }; refuses(input, "invalid-request");
  });
  it("strict-only run refuses retrospective input; both-mode run accepts either", () => {
    refuses(predictionFixture([strict], retro), "evidence-mode-mismatch");
    for (const mode of [strict, retro] as const) expect(validateModelDescriptor(predictionFixture([strict, retro], mode)).evidenceMode).toBe(mode);
  });
  it("does not use training membership, target labels, artifacts, histories or transport-only claims", () => {
    const input = predictionFixture(), poison = () => { throw new Error("unrequested-data-read"); };
    for (const key of ["inputPins", "inputCode", "reports", "labels", "datasetMembers", "targetLabel"])
      Object.defineProperty(input.descriptor, key, { get: poison });
    for (const key of ["history", "labels", "outcome", "targetLabel", "client", "store", "authorize"])
      Object.defineProperty(input, key, { get: poison });
    for (const pin of input.descriptor.datasets) for (const key of ["objectKey", "byteSize", "rows", "members"])
      Object.defineProperty(pin, key, { get: poison });
    for (const pin of input.model.datasets) Object.defineProperty(pin, "recordedAt", { get: poison });
    const hash = vi.spyOn(crypto, "createHash").mockImplementation(() => { throw new Error("unexpected-hash"); });
    let result;
    try { result = validateModelDescriptor(input); } finally { hash.mockRestore(); }
    expect(result?.evidenceMode).toBe(retro);
  });
  it("does not reinterpret knowledge/freshness timestamps or scale validation with sample size", () => {
    const input = predictionFixture(), expected = validateModelDescriptor(input);
    const poison = () => { throw new Error("timestamp-or-history-verification"); };
    for (const key of ["knownAsOf"]) Object.defineProperty(input.context.request, key, { get: poison });
    for (const key of ["cutoff", "checkpoint", "computedAt"]) Object.defineProperty(input.context.feature, key, { get: poison });
    Object.defineProperty(input.context, "freshness", { get: poison });
    for (let n = 2; n <= 16; n++) { input.context.feature.sampleSize = n; expect(validateModelDescriptor(input)).toEqual(expected); }
  });
  it("leaves frozen inputs untouched and owns its returned policy containers", () => {
    const input = predictionFixture(), before = structuredClone(input); freeze(input);
    const result = validateModelDescriptor(input); result.adapter.version = "changed"; result.datasetModes.length = 0;
    expect(input).toEqual(before); expect(validateModelDescriptor(input).adapter).toEqual(input.supported.adapter);
  });
});
