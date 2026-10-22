import { NextResponse, type NextRequest } from "next/server";
// This throwaway deployment has no ordinary app API surface, preventing provider usage.
export const proxy = (request: NextRequest) => request.nextUrl.pathname === "/api/bench61"
  ? NextResponse.next() : new NextResponse(null,{status:404});
export const config = { matcher: "/api/:path*" };
