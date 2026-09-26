import { NextRequest, NextResponse } from "next/server";
import { getFirestoreDb, getAdminAuth } from "@/lib/firebaseAdmin";
import { requireUid, uidOfAlreadyDeletedAccount } from "@/lib/apiAuth";

export const DELETE = async (request: NextRequest) => {
  try {
    const uid = await requireUid(request);
    if (!uid) {
      // requireUid's own checkRevoked lookup fails for an account that
      // no longer exists at all -- which is exactly what a RETRY of an
      // already-completed deletion looks like (the first attempt's
      // response was lost, so the client retried, but by then there's
      // no account left to verify against). If the token is otherwise
      // genuinely valid and simply names an already-deleted account,
      // the desired end state already holds: report success, not a
      // fresh 401 for an operation that's already finished. A token
      // that's invalid for any OTHER reason still gets a real 401.
      const deletedUid = await uidOfAlreadyDeletedAccount(request);
      if (deletedUid) {
        return NextResponse.json({ success: true });
      }
      return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
    }

    // Firestore document deleted BEFORE the Auth record, not after: if
    // Auth deleted first and Firestore then failed, the user's data
    // would be permanently orphaned with no uid that could ever map
    // back to it again -- a silent, unrecoverable leak. This ordering
    // fails cleanly instead: Firestore's delete() is idempotent (a
    // no-op on an already-deleted or never-existed document), which is
    // what makes the whole route safely retryable end to end.
    await getFirestoreDb().collection("users").doc(uid).delete();

    try {
      await getAdminAuth().deleteUser(uid);
    } catch (err) {
      // auth/user-not-found here doesn't mean this call failed -- it
      // means the desired end state (no Auth record for this uid)
      // already holds, most likely because an earlier attempt's Auth
      // deletion actually succeeded server-side but its response never
      // reached us (a network blip), so we reported failure and the
      // client retried. Treating that as a retryable failure again
      // would tell the user to keep retrying an already-finished
      // deletion indefinitely.
      if ((err as { code?: string }).code === "auth/user-not-found") {
        return NextResponse.json({ success: true });
      }

      // Any other error here is a genuine partial state: Firestore data
      // is already gone, but the Auth record isn't. A generic "Internal
      // error" would wrongly suggest nothing happened, so this says so
      // explicitly -- retrying is safe regardless of which branch it
      // takes next time, since both outcomes above are handled.
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
