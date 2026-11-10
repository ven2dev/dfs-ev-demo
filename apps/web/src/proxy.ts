import { NextResponse } from "next/server";

// Disposable harness Preview: suppress ordinary API/provider/cron entry points.
// Production and non-harness deployments retain their existing routing behavior.
export const proxy = () => {
  if (process.env.VERCEL_ENV === "preview" && process.env.SPIKE220_ENABLED === "1") {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.next();
};
export const config = { matcher: "/api/((?!qualification220$).*)" };
