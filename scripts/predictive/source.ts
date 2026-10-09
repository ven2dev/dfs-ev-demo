import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoApplicationCredentials } from "../../tests/db/target.mts";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { captureSourcePrototype, verifySourcePrototype } from "../../src/lib/predictive/sourcePrototype.ts";
import { SOURCE_LIMITS } from "../../src/lib/predictive/sourceTransport.ts";
import { sourceAsset } from "../../src/lib/predictive/sourceAdapters.ts";

export const runSourcePrototype = async (args: string[], environment: NodeJS.ProcessEnv) => {
  assertNoApplicationCredentials(environment);
  if (["TEST_DATABASE_URL", "NEON_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"].some((key) => environment[key] !== undefined)) throw new Error("source-environment-refused");
  const [mode, rootOption, directory, firstOption, first, secondOption, second, ...extra] = args;
  if (rootOption !== "--artifact-root" || !directory || extra.length) throw new Error("source-arguments-refused");
  if (mode === "capture" && firstOption === "--season" && /^\d{4}$/.test(first) && secondOption === "--game-id" && /^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(second)) {
    sourceAsset("player", Number(first));
    if (!second.startsWith(first + "_")) throw new Error("source-arguments-refused");
    const store = await openArtifactStore(directory, SOURCE_LIMITS.responseBytes);
    return captureSourcePrototype(store, Number(first), second);
  }
  if (mode === "verify" && firstOption === "--journal" && /^[a-f0-9]{64}\.json$/.test(first) && secondOption === "--journal-bytes" && /^\d+$/.test(second)) {
    if (!Number.isSafeInteger(Number(second)) || Number(second) < 1 || Number(second) > SOURCE_LIMITS.responseBytes) throw new Error("source-arguments-refused");
    const store = await openArtifactStore(directory, SOURCE_LIMITS.responseBytes);
    return verifySourcePrototype(store, { reference: first, sha256: first.slice(0, -5), byteSize: Number(second) });
  }
  throw new Error("source-arguments-refused");
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSourcePrototype(process.argv.slice(2), process.env);
    console.log(JSON.stringify(result, null, 2));
    if ("report" in result && result.report.status === "refused") process.exitCode = 1;
  } catch { console.error("Predictive source qualification refused or failed."); process.exitCode = 1; }
}
