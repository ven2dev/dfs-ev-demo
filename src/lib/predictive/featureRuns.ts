import type { Bundle } from "./types.ts";
import { canonical, compareText, digest } from "./validation.ts";

export const FEATURE_CODE_VERSION = "predictive-replay-v1";

export type FeatureRunRecord = {
  id: string; mode: "production-research" | "synthetic-proof"; featureVersion: string; candidate: string; playerId: string; gameId: string;
  cutoff: string; computedAt: string; recordedAt: string; codeVersion: string; status: Bundle["status"]; reasons: string[];
  inputDigest: string; executionDigest: string; bundleSha256: string; bundleBytes: string;
  dependencies: { observations: string[]; decisions: string[]; rightsDecisions: string[]; policies: string[]; featureDefinitions: string[] };
};

const sorted = (values: Iterable<string>) => [...new Set(values)].sort(compareText);
const policiesOf = (bundle: Bundle) => sorted([...Object.values(bundle.policies), ...(bundle.reconciliations.length ? ["reconciliation-v1"] : [])]);

// execution_digest, mirrored by predictive_record_feature_run(): SHA-256 over
// unit-separated (\x1f) fields, list items record-separated (\x1e). No ID may
// contain a control character, so the encoding is unambiguous. It binds the
// inputs, rights in force, policies, code version and both times, so a rights
// change alters the execution record without altering the inputs.
export const executionDigest = (fields: { inputDigest: string; rightsDecisions: string[]; policies: string[]; featureVersion: string;
  codeVersion: string; computedAt: string; recordedAt: string }) =>
  digest([fields.inputDigest, sorted(fields.rightsDecisions).join("\x1e"), sorted(fields.policies).join("\x1e"), fields.featureVersion,
    fields.codeVersion, fields.computedAt, fields.recordedAt].join("\x1f"));

// What the recorder function receives: everything except the server-stamped
// recorded_at, the rights it recomputes, and the digest and ID derived from them.
export const featureRunRequest = (bundle: Bundle, synthetic: boolean) => {
  const bundleBytes = canonical(bundle);
  return {
    bundleBytes, bundleSha256: digest(bundleBytes),
    run: { mode: synthetic ? "synthetic-proof" : "production-research", featureVersion: bundle.featureVersion, candidate: bundle.request.candidate,
      playerId: bundle.request.playerId, gameId: bundle.request.gameId, cutoff: bundle.request.cutoff, computedAt: bundle.computedAt,
      codeVersion: FEATURE_CODE_VERSION, status: bundle.status, reasons: bundle.reasons, inputDigest: bundle.inputDigest, bundleSha256: digest(bundleBytes) },
    dependencies: {
      observations: sorted(bundle.dependencies.map((dependency) => dependency.observationId)),
      decisions: sorted([...bundle.reconciliations, ...bundle.completions, ...bundle.participations].map((decision) => decision.decisionId)),
      policies: policiesOf(bundle), featureDefinitions: [bundle.featureVersion],
    },
  };
};

// The complete record for one bundle given the server's recording time and the
// rights it found in force (used by pure tests and to cross-check the server).
export const featureRunRecord = (bundle: Bundle, context: {
  rightsInForce: Map<string, string | null>; synthetic: boolean; recordedAt: string;
}): FeatureRunRecord => {
  const rightsDecisions = sorted([...context.rightsInForce.values()].filter((value): value is string => value !== null));
  const policies = policiesOf(bundle);
  const execution = executionDigest({ inputDigest: bundle.inputDigest, rightsDecisions, policies, featureVersion: bundle.featureVersion,
    codeVersion: FEATURE_CODE_VERSION, computedAt: bundle.computedAt, recordedAt: context.recordedAt });
  const bundleBytes = canonical(bundle);
  return {
    id: "feature-run:" + execution, mode: context.synthetic ? "synthetic-proof" : "production-research",
    featureVersion: bundle.featureVersion, candidate: bundle.request.candidate, playerId: bundle.request.playerId, gameId: bundle.request.gameId,
    cutoff: bundle.request.cutoff, computedAt: bundle.computedAt, recordedAt: context.recordedAt, codeVersion: FEATURE_CODE_VERSION,
    status: bundle.status, reasons: bundle.reasons, inputDigest: bundle.inputDigest, executionDigest: execution, bundleSha256: digest(bundleBytes), bundleBytes,
    dependencies: {
      observations: sorted(bundle.dependencies.map((dependency) => dependency.observationId)),
      decisions: sorted([...bundle.reconciliations, ...bundle.completions, ...bundle.participations].map((decision) => decision.decisionId)),
      rightsDecisions, policies, featureDefinitions: [bundle.featureVersion],
    },
  };
};
