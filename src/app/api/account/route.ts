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
    await getFirestoreDb().collection("users").doc(uid).delete();
    await getAdminAuth().deleteUser(uid);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/account] DELETE failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
