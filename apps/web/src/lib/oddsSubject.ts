import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { SubjectDimension } from "@dfs-ev/db/runtime";

export type SubjectKeyVersion = Readonly<{ version: string; keyHex: string }>;
export type SubjectPolicy = Readonly<{ intervalMs: number; burst: number }>;
export type SubjectPolicies = Readonly<{
  anonymousNetwork: SubjectPolicy; signedNetwork: SubjectPolicy; user: SubjectPolicy;
}>;
export type SubjectReason = "invalid-token" | "identity-unavailable" | "subject-configuration-unavailable";

export const parseSubjectKeyring = (value: unknown): readonly SubjectKeyVersion[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 ||
      value.some(v => !v || typeof v !== "object" || Object.keys(v).sort().join(",") !== "keyHex,version" ||
        typeof v.version !== "string" || !/^[a-z][a-z0-9]{0,15}$/.test(v.version) ||
        typeof v.keyHex !== "string" || !/^[0-9a-f]{64}$/.test(v.keyHex)) ||
      new Set(value.map(v => v.version)).size !== value.length) {
    throw new Error("Invalid subject key configuration");
  }
  return Object.freeze(value.map(v => Object.freeze({ version: v.version, keyHex: v.keyHex })));
};

// Address parser is used only on Vercel's platform-set header. In particular,
// this never picks the first member of a caller-supplied forwarded chain.
export const canonicalSubjectNetwork = (address: string | null): string | null => {
  if (!address || address.includes("%") || !isIP(address)) return null;
  if (isIP(address) === 4) return address;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = normalized.split("::");
  const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  const n = words.map(w => parseInt(w, 16));
  if (n.slice(0, 5).every(x => x === 0) && n[5] === 0xffff) {
    return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join(".");
  }
  return n.slice(0, 4).map(x => x.toString(16).padStart(4, "0")).join(":") + "::/64";
};

const validPolicy = (p: SubjectPolicy) => Number.isSafeInteger(p.intervalMs) && p.intervalMs > 0 &&
  Number.isSafeInteger(p.burst) && p.burst > 0 && p.burst <= 1000 && p.intervalMs * p.burst <= 86_400_000;

// Factory has no supplied-input reader. C2 supplies the validated server
// capability and lazy Firebase verifier. Nothing calls this on hits/followers.
export const createOddsSubjectResolver = (deps: {
  headers: Pick<Headers, "get">;
  platform: "vercel" | "untrusted";
  keyring: readonly SubjectKeyVersion[];
  policies: SubjectPolicies;
  verifiedUid: () => Promise<string | null>;
  warn: (reason: SubjectReason) => void;
}) => {
  let pending: Promise<readonly SubjectDimension[] | null> | undefined;
  return () => pending ??= Promise.resolve().then(async () => {
    const network = deps.platform === "vercel" ? canonicalSubjectNetwork(deps.headers.get("x-vercel-forwarded-for")) : null;
    if (!network) { deps.warn("identity-unavailable"); return null; }
    let ring: readonly SubjectKeyVersion[];
    try {
      ring = parseSubjectKeyring(deps.keyring);
      if (!Object.values(deps.policies).every(validPolicy)) throw new Error("Invalid subject policies");
    } catch { deps.warn("subject-configuration-unavailable"); return null; }
    let uid: string | null = null;
    // Missing token is intentionally silent. Invalid/revoked/expired or verifier
    // errors downgrade to anonymous, never propagate raw SDK errors or identity.
    if (deps.headers.get("authorization")) {
      try { uid = await deps.verifiedUid(); } catch { /* anonymous below */ }
      if (!uid) deps.warn("invalid-token");
    }
    const dimension = (kind: "anonymous-network" | "signed-network" | "user", value: string,
      policy: SubjectPolicy): SubjectDimension => {
      const keys = ring.map(({ version, keyHex }) => `${version}:${kind}:` +
        createHmac("sha256", Buffer.from(keyHex, "hex")).update(kind + "\0" + value).digest("hex"));
      return { keys, report: keys.at(-1)!, ...policy, traffic: uid ? "signed-in" : "anonymous" };
    };
    return uid ? [dimension("signed-network", network, deps.policies.signedNetwork), dimension("user", uid, deps.policies.user)] :
      [dimension("anonymous-network", network, deps.policies.anonymousNetwork)];
  });
};
