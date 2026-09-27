import { describe, it, expect, vi } from "vitest";
import { performAccountDeletion, type AccountDeletionDeps } from "./accountDeletion.ts";

const makeDeps = (overrides: Partial<AccountDeletionDeps> = {}): AccountDeletionDeps => ({
  deleteFirestoreDoc: vi.fn().mockResolvedValue(undefined),
  deleteAuthUser: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("performAccountDeletion", () => {
  it("an unauthorized request is rejected before touching either dependency", async () => {
    const deps = makeDeps();

    const result = await performAccountDeletion({ status: "unauthorized" }, deps);

    expect(result).toEqual({ status: "unauthorized" });
    expect(deps.deleteFirestoreDoc).not.toHaveBeenCalled();
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("a Firestore failure propagates uncaught and never touches Auth", async () => {
    const firestoreError = new Error("Firestore unavailable");
    const deps = makeDeps({ deleteFirestoreDoc: vi.fn().mockRejectedValue(firestoreError) });

    await expect(
      performAccountDeletion({ status: "active", uid: "uid-1" }, deps)
    ).rejects.toThrow(firestoreError);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("an Auth failure after Firestore succeeds reports auth-deletion-failed with the cause", async () => {
    const authError = { code: "auth/internal-error" };
    const deps = makeDeps({ deleteAuthUser: vi.fn().mockRejectedValue(authError) });

    const result = await performAccountDeletion({ status: "active", uid: "uid-1" }, deps);

    expect(result).toEqual({ status: "auth-deletion-failed", cause: authError });
    expect(deps.deleteFirestoreDoc).toHaveBeenCalledWith("uid-1");
  });

  it("a full success deletes both Firestore and Auth for the given uid", async () => {
    const deps = makeDeps();

    const result = await performAccountDeletion({ status: "active", uid: "uid-1" }, deps);

    expect(result).toEqual({ status: "success" });
    expect(deps.deleteFirestoreDoc).toHaveBeenCalledWith("uid-1");
    expect(deps.deleteAuthUser).toHaveBeenCalledWith("uid-1");
  });

  it("a concurrent deletion racing Auth deletion (auth/user-not-found) is still reported as success", async () => {
    const deps = makeDeps({
      deleteAuthUser: vi.fn().mockRejectedValue({ code: "auth/user-not-found" }),
    });

    const result = await performAccountDeletion({ status: "active", uid: "uid-1" }, deps);

    expect(result).toEqual({ status: "success" });
  });

  it("retrying an already-deleted account is idempotent success and never touches Auth", async () => {
    const deps = makeDeps();

    const result = await performAccountDeletion({ status: "already-deleted", uid: "uid-1" }, deps);

    expect(result).toEqual({ status: "success" });
    expect(deps.deleteFirestoreDoc).toHaveBeenCalledWith("uid-1");
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });
});
