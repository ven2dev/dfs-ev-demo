import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, link, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCreatorKey } from "../../src/lib/creatorDecisions.ts";
import { assertValidWindow } from "../../src/lib/creatorVideoRule.ts";
import { loadRegistration, parseCreatorsFile, windowStart } from "./creatorInputs.ts";
import {
  readPrivateJson,
  readPrivateJsonOptional,
  writePrivateJson,
} from "./privateOutput.ts";

export const GATE_COMMITMENT_ALGORITHM = "sha256";
export const GATE_COMMITMENT_VERSION = 1;
export const GATE_DOMAIN_SEPARATOR = "dfs-ev-demo:creator-readiness-gate:v1\0";
export const MINIMUM_REVIEWED_GRADABLE_PICKS_OVERALL = 500;
export const MINIMUM_REVIEWED_GRADABLE_PICKS_PER_CREATOR = 100;
export const MAXIMUM_FEATURE_COUNT = 10;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export class ReadinessGateError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new ReadinessGateError(code);
};

export type PrivateGateRecord = {
  formatVersion: 1;
  eligibleCreatorKeys: string[];
  saltHex: string;
};

export type ReadinessGate = {
  commitment: {
    algorithm: typeof GATE_COMMITMENT_ALGORITHM;
    version: typeof GATE_COMMITMENT_VERSION;
    digest: string;
  };
  eligibleCreatorCount: number;
  minimumReviewedGradablePicksOverall: typeof MINIMUM_REVIEWED_GRADABLE_PICKS_OVERALL;
  minimumReviewedGradablePicksPerCreator: typeof MINIMUM_REVIEWED_GRADABLE_PICKS_PER_CREATOR;
  maximumFeatureCount: typeof MAXIMUM_FEATURE_COUNT;
  collectionWindow: {
    startSeason: 2024;
    startWeek: 1;
    endSeason: number;
    endWeek: number;
    seasonType: "regular";
  };
  ruleVersion: string;
  registeredAt: string;
};

const sortedUniqueKeys = (keys: readonly string[]): string[] => {
  if (keys.length === 0 || keys.some((key) => !isCreatorKey(key))) {
    return fail("invalid-gate-creators");
  }
  const sorted = [...keys].sort();
  if (new Set(sorted).size !== sorted.length) return fail("invalid-gate-creators");
  return sorted;
};

export const canonicalGateManifest = (keys: readonly string[]): string =>
  JSON.stringify({ formatVersion: 1, eligibleCreatorKeys: sortedUniqueKeys(keys) });

export const computeGateCommitment = (keys: readonly string[], saltHex: string): string => {
  if (!SHA256_HEX.test(saltHex)) return fail("invalid-gate-salt");
  return createHash("sha256")
    .update(GATE_DOMAIN_SEPARATOR, "utf8")
    .update(Buffer.from(saltHex, "hex"))
    .update(canonicalGateManifest(keys), "utf8")
    .digest("hex");
};

export const parsePrivateGateRecord = (input: unknown): PrivateGateRecord => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("invalid-private-gate-record");
  }
  const value = input as Record<string, unknown>;
  if (
    value.formatVersion !== 1 ||
    !Array.isArray(value.eligibleCreatorKeys) ||
    typeof value.saltHex !== "string" ||
    Object.keys(value).sort().join(",") !== "eligibleCreatorKeys,formatVersion,saltHex"
  ) {
    return fail("invalid-private-gate-record");
  }
  let keys: string[];
  try {
    keys = sortedUniqueKeys(value.eligibleCreatorKeys as string[]);
  } catch {
    return fail("invalid-private-gate-record");
  }
  if (JSON.stringify(keys) !== JSON.stringify(value.eligibleCreatorKeys) || !SHA256_HEX.test(value.saltHex)) {
    return fail("invalid-private-gate-record");
  }
  return { formatVersion: 1, eligibleCreatorKeys: keys, saltHex: value.saltHex };
};

export const buildReadinessGate = ({
  keys,
  saltHex,
  registeredAt,
  endSeason,
  endWeek,
  ruleVersion,
}: {
  keys: readonly string[];
  saltHex: string;
  registeredAt: string;
  endSeason: number;
  endWeek: number;
  ruleVersion: string;
}): ReadinessGate => {
  const creators = sortedUniqueKeys(keys);
  if (!ISO_INSTANT.test(registeredAt) || Number.isNaN(Date.parse(registeredAt))) {
    return fail("invalid-gate-registration-time");
  }
  try {
    assertValidWindow({ endSeason, endWeek });
  } catch {
    return fail("gate-window-mismatch");
  }
  return {
    commitment: {
      algorithm: GATE_COMMITMENT_ALGORITHM,
      version: GATE_COMMITMENT_VERSION,
      digest: computeGateCommitment(creators, saltHex),
    },
    eligibleCreatorCount: creators.length,
    minimumReviewedGradablePicksOverall: MINIMUM_REVIEWED_GRADABLE_PICKS_OVERALL,
    minimumReviewedGradablePicksPerCreator: MINIMUM_REVIEWED_GRADABLE_PICKS_PER_CREATOR,
    maximumFeatureCount: MAXIMUM_FEATURE_COUNT,
    collectionWindow: {
      startSeason: 2024,
      startWeek: 1,
      endSeason,
      endWeek,
      seasonType: "regular",
    },
    ruleVersion,
    registeredAt,
  };
};

export const parseReadinessGate = (input: unknown): ReadinessGate => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("invalid-readiness-gate");
  }
  const value = input as Record<string, unknown>;
  const commitment = value.commitment as Record<string, unknown> | null;
  const window = value.collectionWindow as Record<string, unknown> | null;
  if (
    Object.keys(value).sort().join(",") !== [
      "collectionWindow",
      "commitment",
      "eligibleCreatorCount",
      "maximumFeatureCount",
      "minimumReviewedGradablePicksOverall",
      "minimumReviewedGradablePicksPerCreator",
      "registeredAt",
      "ruleVersion",
    ].join(",") ||
    typeof commitment !== "object" ||
    commitment === null ||
    Object.keys(commitment).sort().join(",") !== "algorithm,digest,version" ||
    commitment.algorithm !== GATE_COMMITMENT_ALGORITHM ||
    commitment.version !== GATE_COMMITMENT_VERSION ||
    typeof commitment.digest !== "string" ||
    !SHA256_HEX.test(commitment.digest) ||
    !Number.isInteger(value.eligibleCreatorCount) ||
    (value.eligibleCreatorCount as number) < 1 ||
    (value.eligibleCreatorCount as number) > 20 ||
    value.minimumReviewedGradablePicksOverall !== MINIMUM_REVIEWED_GRADABLE_PICKS_OVERALL ||
    value.minimumReviewedGradablePicksPerCreator !== MINIMUM_REVIEWED_GRADABLE_PICKS_PER_CREATOR ||
    value.maximumFeatureCount !== MAXIMUM_FEATURE_COUNT ||
    typeof window !== "object" ||
    window === null ||
    Object.keys(window).sort().join(",") !== "endSeason,endWeek,seasonType,startSeason,startWeek" ||
    window.startSeason !== 2024 ||
    window.startWeek !== 1 ||
    !Number.isInteger(window.endSeason) ||
    !Number.isInteger(window.endWeek) ||
    window.seasonType !== "regular" ||
    typeof value.ruleVersion !== "string" ||
    !/^v[0-9]{1,3}$/.test(value.ruleVersion) ||
    typeof value.registeredAt !== "string" ||
    !ISO_INSTANT.test(value.registeredAt) ||
    Number.isNaN(Date.parse(value.registeredAt))
  ) {
    return fail("invalid-readiness-gate");
  }
  try {
    assertValidWindow({ endSeason: window.endSeason as number, endWeek: window.endWeek as number });
  } catch {
    return fail("invalid-readiness-gate");
  }
  return value as unknown as ReadinessGate;
};

const publicGatePath = fileURLToPath(new URL("./readiness-gate.json", import.meta.url));

const assertPublicGateAvailable = async (path: string): Promise<void> => {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    return fail("readiness-gate-unwritable");
  }
  return fail("readiness-gate-exists");
};

const writePublicGate = async (path: string, gate: ReadinessGate): Promise<void> => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
  } catch {
    return fail("readiness-gate-unwritable");
  }
  try {
    await handle.writeFile(JSON.stringify(gate, null, 2) + "\n");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      return fail((error as NodeJS.ErrnoException).code === "EEXIST" ? "readiness-gate-exists" : "readiness-gate-unwritable");
    }
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
};

export const registerReadinessGate = async ({
  creatorsPath,
  privateRecordPath,
  now,
  outputPath = publicGatePath,
}: {
  creatorsPath: string;
  privateRecordPath: string;
  now: Date;
  outputPath?: string;
}): Promise<ReadinessGate> => {
  // Refuse an immutable public registration before opening either private
  // input. In particular, losing the private record must never generate a new
  // salt that no longer verifies the already-committed digest.
  await assertPublicGateAvailable(outputPath);
  // The existing creator parser validates the private source without ever
  // copying channel names or seed videos into either gate record.
  const creators = parseCreatorsFile(await readPrivateJson(creatorsPath));
  const keys = sortedUniqueKeys(creators.map((creator) => creator.key));
  const existing = await readPrivateJsonOptional(privateRecordPath);
  let privateRecord: PrivateGateRecord;
  if (existing === undefined) {
    privateRecord = { formatVersion: 1, eligibleCreatorKeys: keys, saltHex: randomBytes(32).toString("hex") };
    await writePrivateJson(privateRecordPath, privateRecord);
  } else {
    privateRecord = parsePrivateGateRecord(existing);
    if (JSON.stringify(privateRecord.eligibleCreatorKeys) !== JSON.stringify(keys)) {
      return fail("gate-creators-changed");
    }
  }
  const registration = await loadRegistration();
  const start = windowStart();
  if (start.getUTCFullYear() !== 2024) return fail("gate-window-mismatch");
  const gate = buildReadinessGate({
    keys,
    saltHex: privateRecord.saltHex,
    registeredAt: now.toISOString(),
    endSeason: registration.window.endSeason,
    endWeek: registration.window.endWeek,
    ruleVersion: registration.ruleVersion,
  });
  await writePublicGate(outputPath, gate);
  return gate;
};

export const loadReadinessGate = async (path = publicGatePath): Promise<ReadinessGate> => {
  try {
    return parseReadinessGate(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return fail("invalid-readiness-gate");
  }
};
