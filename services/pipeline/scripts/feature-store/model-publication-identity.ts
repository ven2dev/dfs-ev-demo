import { readFile } from "node:fs/promises";
import { EVALUATION_ROOT, evaluationCodeIdentity } from "./evaluation-fixture.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";

// #164's input-generation identity is independent of model publication. The
// #165 runner binds both that dependency and its own runtime/proposal sources.
export const modelPublicationCodeIdentity = async () => {
  const base = await evaluationCodeIdentity();
  const paths = ["packages/db/proposals/165_model_manifests.sql",
    "services/pipeline/src/featureStore/modelManifests.ts",
    "services/pipeline/scripts/feature-store/model-publication-identity.ts",
    "services/pipeline/scripts/feature-store/model-publication-run.ts",
    "services/pipeline/scripts/feature-store/model-publication-measure.ts"];
  const extra = await Promise.all(paths.map(async path => [path, sha256(await readFile(new URL(path, EVALUATION_ROOT)))]));
  const codeHashes = Object.fromEntries(Object.entries({ ...base.codeHashes, ...Object.fromEntries(extra) }).sort(([a], [b]) => a.localeCompare(b)));
  return { code: { gitSha: base.code.gitSha, contentSha256: sha256(Buffer.from(JSON.stringify(codeHashes))) }, codeHashes };
};
