import { NextRequest, NextResponse } from "next/server";
import { getFirestoreDb, getAdminAuth } from "@/lib/firebaseAdmin";
import { checkUidForDeletion } from "@/lib/apiAuth";
import { performAccountDeletion } from "@/lib/accountDeletion";

export const DELETE = async (request: NextRequest) => {
  try {
    const uidCheck = await checkUidForDeletion(request);

    const result = await performAccountDeletion(uidCheck, {
      // Firestore's delete() is idempotent (a no-op on an
      // already-deleted or never-existed document), so this is always
      // safe to run regardless of whether the Auth record is still
      // "active" or was already confirmed "already-deleted" -- it's
      // the only way to guarantee cleanup regardless of HOW the Auth
      // record came to be gone.
      deleteFirestoreDoc: async (uid) => {
        await getFirestoreDb().collection("users").doc(uid).delete();
      },
      deleteAuthUser: async (uid) => {
        await getAdminAuth().deleteUser(uid);
      },
    });

    if (result.status === "unauthorized") {
      return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
    }

    if (result.status === "auth-deletion-failed") {
      // A genuine partial state: Firestore data is already gone, but
      // the Auth record isn't. A generic "Internal error" would
      // wrongly suggest nothing happened, so this says so explicitly
      // -- retrying is safe regardless of which outcome it hits next
      // time, since the only other possibilities are unauthorized
      // (handled above) or success (performAccountDeletion already
      // treats a retried, already-deleted account as success).
      console.error(
        "[api/account] Auth user deletion failed after Firestore data was already deleted:",
        result.cause
      );
      return NextResponse.json(
        {
          success: false,
          reason: "Your data was deleted, but finishing account removal failed. Please try again.",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/account] DELETE failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
