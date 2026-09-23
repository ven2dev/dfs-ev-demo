import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getFirestoreDb } from "@/lib/firebaseAdmin";
import { requireUid } from "@/lib/apiAuth";
import type { WatchedProp } from "@/types";

// Idempotent by design (state-setting, not toggling): POST always means
// "ensure watched," DELETE always means "ensure unwatched" -- calling
// either repeatedly has the same net effect.
//
// Both writes target only this one propId key inside the watchlist map,
// never the whole map -- the live SSE hook and other in-flight watch/
// unwatch calls touch different keys concurrently, and a whole-map write
// here would clobber whatever they wrote in between.

export const POST = async (request: NextRequest) => {
  try {
    const uid = await requireUid(request);
    if (!uid) {
      return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
    }

    const { propId } = await request.json();
    // Matches the client's own optimistic placeholder exactly -- the real
    // evScore/evHistory arrive moments later via the live SSE stream, not
    // from this write.
    const entry: WatchedProp = {
      propId,
      evScore: { modelProb: 0, impliedProb: 0, edge: 0 },
      evHistory: [],
    };
    // set(..., {merge: true}) with a nested object merges recursively --
    // this creates the user's document on their first-ever watch, and
    // only touches this one key inside watchlist either way.
    await getFirestoreDb()
      .collection("users")
      .doc(uid)
      .set({ watchlist: { [propId]: entry } }, { merge: true });
    return NextResponse.json({ success: true, propId });
  } catch (err) {
    console.error("[api/watchlist] POST failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};

export const DELETE = async (request: NextRequest) => {
  let propId: string | undefined;
  try {
    const uid = await requireUid(request);
    if (!uid) {
      return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
    }

    ({ propId } = await request.json());
    // merge can't remove a key by omission -- an explicit dotted path +
    // FieldValue.delete() is the correct way to remove one nested map key
    // without touching its siblings.
    await getFirestoreDb()
      .collection("users")
      .doc(uid)
      .update({ [`watchlist.${propId}`]: FieldValue.delete() });
    return NextResponse.json({ success: true, propId });
  } catch (err) {
    // NOT_FOUND (no document yet, or the field was never set) means
    // already unwatched -- idempotent no-op, not a failure.
    if ((err as { code?: number }).code === 5) {
      return NextResponse.json({ success: true, propId });
    }
    console.error("[api/watchlist] DELETE failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
