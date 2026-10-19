import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronHeader } from "@/lib/cronAuth";
import { evaluateDatabaseReadiness } from "@/lib/dbReadiness";
import { getDatabaseReadinessSnapshot } from "@/lib/dbReadinessRepo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

const response = (body: object, status: number) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function GET(request: NextRequest) {
  const secret = process.env.DB_READINESS_SECRET;
  if (!secret?.trim()) return response({ status: "not-ready", reasons: ["not-configured"] }, 503);
  if (!isAuthorizedCronHeader(request.headers.get("authorization"), secret)) {
    return response({ status: "unauthorized" }, 401);
  }
  if (!process.env.DATABASE_URL?.trim()) {
    return response({ status: "not-ready", reasons: ["not-configured"] }, 503);
  }
  try {
    const result = evaluateDatabaseReadiness(await getDatabaseReadinessSnapshot());
    return response(result, result.status === "ready" ? 200 : 503);
  } catch {
    return response({ status: "not-ready", reasons: ["database-unavailable"] }, 503);
  }
}
