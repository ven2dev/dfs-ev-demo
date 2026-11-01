import { NextResponse, type NextRequest } from "next/server";

// Disposable harness Preview: suppress ordinary API/provider/cron entry points.
// Production and non-harness deployments retain their existing routing behavior.
export const proxy = (request: NextRequest) => {
  if (process.env.VERCEL_ENV === "preview" && process.env.SPIKE220_ENABLED === "1") {
    return request.nextUrl.pathname === "/api/qualification220"
      ? NextResponse.next()
      : new NextResponse(null, { status: 404 });
  }
  return NextResponse.next();
};
export const config = { matcher: "/api/:path*" };
