import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronHeader } from "@/lib/cronAuth";
import { evaluateDatabaseReadiness } from "@dfs-ev/db/runtime";
import { getDatabaseReadinessSnapshot } from "@/lib/dbReadinessRepo";
import { serverConfig } from "@/lib/config.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

const response = (body: object, status: number) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function GET(request: NextRequest) {
  let secret: string;
  try { secret = serverConfig.dbReadinessSecret(); }
  catch { return response({ status: "not-ready", reasons: ["not-configured"] }, 503); }
  if (!isAuthorizedCronHeader(request.headers.get("authorization"), secret)) {
    return response({ status: "unauthorized" }, 401);
  }
  try { serverConfig.database(); }
  catch { return response({ status: "not-ready", reasons: ["not-configured"] }, 503); }
  try {
    const result = evaluateDatabaseReadiness(await getDatabaseReadinessSnapshot());
    return response(result, result.status === "ready" ? 200 : 503);
  } catch {
    return response({ status: "not-ready", reasons: ["database-unavailable"] }, 503);
  }
}
