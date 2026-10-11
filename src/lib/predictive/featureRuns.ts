import type { Bundle } from "./types.ts";
import { canonical, compareText, digest } from "./validation.ts";

export const FEATURE_CODE_VERSION = "predictive-replay-v1";

export type FeatureRunRecord = {
  id: string; mode: "production-research" | "synthetic-proof"; featureVersion: string; candidate: string; playerId: string; gameId: string;
  cutoff: string; computedAt: string; recordedAt: string; codeVersion: string; status: Bundle["status"]; reasons: string[];
  inputDigest: string; executionDigest: string; bundleSha256: string; bundleBytes: string;
  dependencies: { observations: string[]; decisions: string[]; rightsDecisions: string[]; policies: string[]; featureDefinitions: string[] };
};

// Builds the immutable record for one computed bundle. input_digest is the
// bundle's own cutoff-time digest; execution_digest additionally binds the
// rights in force, policies, code version and both computation and record times,
// so a rights change alters the execution record without altering the inputs.
export const featureRunRecord = (bundle: Bundle, context: {
  rightsInForce: Map<string, string | null>; synthetic: boolean; recordedAt: string;
}): FeatureRunRecord => {
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort(compareText);
  const rightsDecisions = sorted([...context.rightsInForce.values()].filter((value): value is string => value !== null));
  const policies = sorted([...Object.values(bundle.policies), ...(bundle.reconciliations.length ? ["reconciliation-v1"] : [])]);
  const executionDigest = digest(canonical({ inputDigest: bundle.inputDigest, rightsDecisions, policies, featureVersion: bundle.featureVersion,
    codeVersion: FEATURE_CODE_VERSION, computedAt: bundle.computedAt, recordedAt: context.recordedAt }));
  const bundleBytes = canonical(bundle);
  return {
    id: "feature-run:" + executionDigest, mode: context.synthetic ? "synthetic-proof" : "production-research",
    featureVersion: bundle.featureVersion, candidate: bundle.request.candidate, playerId: bundle.request.playerId, gameId: bundle.request.gameId,
    cutoff: bundle.request.cutoff, computedAt: bundle.computedAt, recordedAt: context.recordedAt, codeVersion: FEATURE_CODE_VERSION,
    status: bundle.status, reasons: bundle.reasons, inputDigest: bundle.inputDigest, executionDigest, bundleSha256: digest(bundleBytes), bundleBytes,
    dependencies: {
      observations: sorted(bundle.dependencies.map((dependency) => dependency.observationId)),
      decisions: sorted([...bundle.reconciliations, ...bundle.completions, ...bundle.participations].map((decision) => decision.decisionId)),
      rightsDecisions, policies, featureDefinitions: [bundle.featureVersion],
    },
  };
};
