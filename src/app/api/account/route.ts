import { NextRequest, NextResponse } from "next/server";
import { getFirestoreDb, getAdminAuth } from "@/lib/firebaseAdmin";
import { checkUidForDeletion } from "@/lib/apiAuth";

export const DELETE = async (request: NextRequest) => {
  try {
    const result = await checkUidForDeletion(request);
    if (result.status === "unauthorized") {
      return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
    }
    const uid = result.uid;

    // Runs regardless of whether the Auth record is still "active" or
    // was already confirmed "already-deleted" above -- Firestore's
    // delete() is idempotent (a no-op on an already-deleted or
    // never-existed document), so this is always safe, and it's the
    // only way to guarantee cleanup regardless of HOW the Auth record
    // came to be gone. A fully-completed prior run of this exact route
    // is the common case, but not the only possible one (e.g. the Auth
    // user being removed some other way, with the Firestore document
    // never touched at all).
    await getFirestoreDb().collection("users").doc(uid).delete();

    if (result.status === "already-deleted") {
      return NextResponse.json({ success: true });
    }

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
