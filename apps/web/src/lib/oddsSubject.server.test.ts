import { describe, expect, it, vi } from "vitest";
import { canonicalSubjectNetwork, createOddsSubjectResolver, parseSubjectKeyring } from "./oddsSubject";
const keyring = [{ version: "v1", keyHex: "11".repeat(32) }];
const policies = { anonymousNetwork: { intervalMs: 1000, burst: 2 },
  signedNetwork: { intervalMs: 1000, burst: 100 }, user: { intervalMs: 1000, burst: 5 } };
const make = (headers: Record<string, string> = {}, uid: string | null = null) => {
  const warn = vi.fn(), verifiedUid = vi.fn(async () => uid);
  const deps = { headers: new Headers({ "x-vercel-forwarded-for": "203.0.113.7", ...headers }),
    platform: "vercel" as const, keyring, policies, warn, verifiedUid };
  return { deps, warn, verifiedUid, resolve: createOddsSubjectResolver(deps) };
};
describe("#223 HMAC subject adapter", () => {
  it("is lazy; absent token remains anonymous and coalesces resolution", async () => {
    const m = make(); expect(m.verifiedUid).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([m.resolve(), m.resolve()]);
    expect(a).toBe(b); expect(a).toHaveLength(1); expect(a![0]).toMatchObject({ traffic: "anonymous", burst: 2 });
    expect(m.verifiedUid).not.toHaveBeenCalled(); expect(m.warn).not.toHaveBeenCalled();
  });
  it("verified users get primary user policy and looser network backstop, HMAC only", async () => {
    const m = make({ authorization: "Bearer synthetic-token" }, "synthetic-uid"); const dims = await m.resolve();
    expect(dims).toHaveLength(2); expect(dims?.map(d => d.burst)).toEqual([100, 5]);
    expect(JSON.stringify(dims)).not.toMatch(/203\.0\.113|synthetic-uid|synthetic-token/);
    expect(dims![0].keys[0]).toMatch(/^v1:signed-network:[a-f0-9]{64}$/);
    expect(dims![1].keys[0]).toMatch(/^v1:user:[a-f0-9]{64}$/);
  });
  it.each(["invalid", "expired", "revoked"])("%s token is anonymous and logs one reason", async () => {
    const m = make({ authorization: "Bearer synthetic-" + "invalid" });
    expect(await m.resolve()).toHaveLength(1); await m.resolve();
    expect(m.warn.mock.calls).toEqual([["invalid-token"]]);
  });
  it("verifier errors become anonymous without reflecting SDK details", async () => {
    const m = make({ authorization: "Bearer synthetic" });m.verifiedUid.mockRejectedValue(new Error("secret SQL UID network"));
    expect(await m.resolve()).toHaveLength(1);expect(m.warn.mock.calls).toEqual([["invalid-token"]]);
  });
  it("ignores spoofed alternative headers and client UID", async () => {
    const a = await make().resolve();
    const b = await make({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "8.8.8.8", "x-user-id": "forged" }).resolve();
    expect(a).toEqual(b);
    const m = make({ "x-vercel-forwarded-for": "203.0.113.1, 8.8.8.8" });
    expect(await m.resolve()).toBeNull(); expect(m.warn).toHaveBeenCalledWith("identity-unavailable");
  });
  it("untrusted platform input never supplies network authority", async () => {
    const m = make();expect(await createOddsSubjectResolver({ ...m.deps, platform: "untrusted" })()).toBeNull();
    expect(m.verifiedUid).not.toHaveBeenCalled();
  });
  it("overlap emits both versions with only the newest reporting key", async () => {
    const m = make(); const dims = await createOddsSubjectResolver({ ...m.deps,
      keyring: [...keyring, { version: "v2", keyHex: "22".repeat(32) }] })();
    expect(dims![0].keys).toHaveLength(2); expect(dims![0].report).toBe(dims![0].keys[1]);
  });
  it.each([[], [{ version: "v1", keyHex: "private" }], [...keyring, ...keyring]].map((value, i) => [i, value] as const))("rejects malformed keyring %i without reflecting input", (_i, value) => {
    expect(() => parseSubjectKeyring(value)).toThrow("Invalid subject key configuration");
  });
  it.each([
    ["203.0.113.7", "203.0.113.7"], ["::ffff:203.0.113.7", "203.0.113.7"],
    ["2001:db8:abcd:12::1", "2001:0db8:abcd:0012::/64"],
    ["2001:0DB8:abcd:0012:ffff::abcd", "2001:0db8:abcd:0012::/64"],
    ["fe80::1%en0", null], ["not-an-ip", null], ["127.1", null], ["", null],
  ])("canonicalizes/rejects %s", (input, output) => expect(canonicalSubjectNetwork(input)).toBe(output));
});
