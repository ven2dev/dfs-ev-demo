import { describe, it, expect, vi, afterEach } from "vitest";
import type { NextRequest } from "next/server";

const verifyIdToken = vi.fn();

afterEach(() => {
  verifyIdToken.mockReset();
  vi.unstubAllEnvs();
});

vi.mock("./firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken }),
}));

// Import after the mock so requireUid/checkUidForDeletion resolve
// getAdminAuth to the fake above, not the real server-only-guarded
// firebaseAdmin.ts (which would require real Firebase credentials).
const { requireUid, requireAdminUid, checkUidForDeletion } = await import("./apiAuth.ts");

const fakeRequest = (headers: Record<string, string>): NextRequest =>
  ({
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
  }) as unknown as NextRequest;

const authedRequest = (token = "a-token") => fakeRequest({ authorization: `Bearer ${token}` });

describe("requireUid", () => {
  it("returns null with no Authorization header, never calling Firebase", () => {
    return requireUid(fakeRequest({})).then((uid) => {
      expect(uid).toBe(null);
      expect(verifyIdToken).not.toHaveBeenCalled();
    });
  });

  it("returns the uid for a valid, non-revoked token", async () => {
    verifyIdToken.mockResolvedValueOnce({ uid: "uid-1" });

    const uid = await requireUid(authedRequest());

    expect(uid).toBe("uid-1");
    expect(verifyIdToken).toHaveBeenCalledWith("a-token", true);
  });

  it("returns null for a revoked token", async () => {
    verifyIdToken.mockRejectedValueOnce({ code: "auth/id-token-revoked" });

    expect(await requireUid(authedRequest())).toBe(null);
  });

  it("returns null for a stale token from a since-deleted account -- it must not recreate data", async () => {
    verifyIdToken.mockRejectedValueOnce({ code: "auth/user-not-found" });

    expect(await requireUid(authedRequest())).toBe(null);
  });
});

describe("requireAdminUid", () => {
  it("throws when ADMIN_UID is not configured -- a deploy misconfiguration, not an auth failure", async () => {
    vi.stubEnv("ADMIN_UID", "");

    await expect(requireAdminUid(authedRequest())).rejects.toThrow("ADMIN_UID is not set");
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("returns the uid when the caller's verified uid matches ADMIN_UID", async () => {
    vi.stubEnv("ADMIN_UID", "owner-uid");
    verifyIdToken.mockResolvedValueOnce({ uid: "owner-uid" });

    expect(await requireAdminUid(authedRequest())).toBe("owner-uid");
  });

  it("returns null for a validly signed-in user who just isn't the admin", async () => {
    vi.stubEnv("ADMIN_UID", "owner-uid");
    verifyIdToken.mockResolvedValueOnce({ uid: "someone-else" });

    expect(await requireAdminUid(authedRequest())).toBe(null);
  });

  it("returns null with no Authorization header at all", async () => {
    vi.stubEnv("ADMIN_UID", "owner-uid");

    expect(await requireAdminUid(fakeRequest({}))).toBe(null);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
});

describe("checkUidForDeletion", () => {
  it("reports unauthorized with no Authorization header", async () => {
    expect(await checkUidForDeletion(fakeRequest({}))).toEqual({ status: "unauthorized" });
  });

  it("reports active for a valid, non-revoked token", async () => {
    verifyIdToken.mockResolvedValueOnce({ uid: "uid-1" });

    expect(await checkUidForDeletion(authedRequest())).toEqual({
      status: "active",
      uid: "uid-1",
    });
  });

  it("reports unauthorized for a revoked (but still-existing) account", async () => {
    verifyIdToken.mockRejectedValueOnce({ code: "auth/id-token-revoked" });

    expect(await checkUidForDeletion(authedRequest())).toEqual({ status: "unauthorized" });
  });

  it("reports already-deleted for a stale token whose account genuinely no longer exists", async () => {
    verifyIdToken
      .mockRejectedValueOnce({ code: "auth/user-not-found" })
      .mockResolvedValueOnce({ uid: "uid-1" });

    expect(await checkUidForDeletion(authedRequest())).toEqual({
      status: "already-deleted",
      uid: "uid-1",
    });
    expect(verifyIdToken).toHaveBeenNthCalledWith(1, "a-token", true);
    expect(verifyIdToken).toHaveBeenNthCalledWith(2, "a-token", false);
  });

  it("reports unauthorized for a malformed token that fails even the unchecked re-verification", async () => {
    verifyIdToken
      .mockRejectedValueOnce({ code: "auth/user-not-found" })
      .mockRejectedValueOnce(new Error("malformed"));

    expect(await checkUidForDeletion(authedRequest())).toEqual({ status: "unauthorized" });
  });
});
