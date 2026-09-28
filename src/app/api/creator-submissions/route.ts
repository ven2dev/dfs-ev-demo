import { NextRequest, NextResponse } from "next/server";
import { requireAdminUid } from "@/lib/apiAuth";
import { insertSubmission, listSubmissions } from "@/lib/creatorSubmissionsRepo";

// 403, not 401 -- requireAdminUid already distinguishes "no valid
// session" from "signed in, but not the admin" (both return null
// today, but this route's response is about THIS resource's access
// rule, not the caller's auth state in general).
const forbidden = () =>
  NextResponse.json({ success: false, reason: "Forbidden" }, { status: 403 });

export const POST = async (request: NextRequest) => {
  try {
    const uid = await requireAdminUid(request);
    if (!uid) return forbidden();

    const body = await request.json();
    const channelName = typeof body.channelName === "string" ? body.channelName.trim() : "";
    const transcriptText =
      typeof body.transcriptText === "string" ? body.transcriptText.trim() : "";
    const videoUrl =
      typeof body.videoUrl === "string" && body.videoUrl.trim() ? body.videoUrl.trim() : undefined;
    const videoTitle =
      typeof body.videoTitle === "string" && body.videoTitle.trim()
        ? body.videoTitle.trim()
        : undefined;

    if (!channelName || !transcriptText) {
      return NextResponse.json(
        { success: false, reason: "channelName and transcriptText are required" },
        { status: 400 }
      );
    }

    const result = await insertSubmission({ channelName, videoUrl, videoTitle, transcriptText });
    return NextResponse.json({ success: true, result });
  } catch (err) {
    console.error("[api/creator-submissions] POST failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};

export const GET = async (request: NextRequest) => {
  try {
    const uid = await requireAdminUid(request);
    if (!uid) return forbidden();

    const submissions = await listSubmissions();
    return NextResponse.json({ success: true, submissions });
  } catch (err) {
    console.error("[api/creator-submissions] GET failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
