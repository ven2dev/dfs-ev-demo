import { NextRequest, NextResponse } from "next/server";
import { getFirestoreDb } from "@/lib/firebaseAdmin";
import { requireUid } from "@/lib/apiAuth";

export const GET = async (request: NextRequest) => {
  const uid = await requireUid(request);
  if (!uid) {
    return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
  }

  try {
    const snap = await getFirestoreDb().collection("users").doc(uid).get();
    if (!snap.exists) {
      // Brand-new user, no document yet -- the client keeps its own
      // existing default state rather than this route inventing one.
      // The first real document gets created by the next write, not by
      // this read.
      return NextResponse.json({ success: true, exists: false, data: null });
    }
    return NextResponse.json({ success: true, exists: true, data: snap.data() });
  } catch (err) {
    console.error("[api/user-data] GET failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
