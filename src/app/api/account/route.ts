import { NextRequest, NextResponse } from "next/server";
import { getFirestoreDb, getAdminAuth } from "@/lib/firebaseAdmin";
import { requireUid } from "@/lib/apiAuth";

export const DELETE = async (request: NextRequest) => {
  try {
    const uid = await requireUid(request);
    if (!uid) {
      return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
    }

    // Firestore document deleted BEFORE the Auth record, not after. If
    // the Firestore delete succeeds and the Auth delete then fails, the
    // account is gone and unrecoverable -- an honest, if unfortunate,
    // terminal state. The reverse ordering is worse: if Auth deletes
    // successfully but Firestore then fails, the user's data is
    // permanently orphaned with no uid that will ever map back to it
    // again -- a silent, unrecoverable leak rather than a clean failure.
    //
    // Firestore's delete() is idempotent -- deleting an already-deleted
    // (or never-existed) document is a no-op, not an error. That's what
    // makes this whole route safely retryable: if the Auth deletion
    // below fails, calling DELETE again just re-runs a no-op here and
    // retries the Auth step, no separate compensation logic needed.
    await getFirestoreDb().collection("users").doc(uid).delete();

    try {
      await getAdminAuth().deleteUser(uid);
    } catch (err) {
      // Firestore data is already gone at this point -- a generic
      // "Internal error" here would wrongly suggest nothing happened.
      // The account is genuinely in a partial state (data deleted, Auth
      // record still present); retrying is safe, so say so explicitly.
      console.error(
        "[api/account] Auth user deletion failed after Firestore data was already deleted:",
        err
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
