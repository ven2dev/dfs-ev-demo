import { admissionRefusals } from "@/lib/bench61-functional";
import { executeProbe } from "@/lib/bench61-probe";
import type { ProbeAction } from "@/lib/bench61-probe-policy";
export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };
// Server log only: fixed reason codes, never request or environment values.
// The public response stays an undifferentiated 404.
const refuse = (reasons: string[]) => {
  console.warn(JSON.stringify({event:"bench61_admission_refused",reasons}));
  return new Response(null,{status:404,headers});
};
export const POST = async (request: Request) => {
  if (Number(request.headers.get("content-length")) > 1024) return refuse(["body_too_large"]);
  let body: {token?:unknown;action?:unknown};
  try {
    const text=await request.text();
    if(text.length>1024) return refuse(["body_too_large"]);
    body=JSON.parse(text);
  } catch { return refuse(["body_unparseable"]); }
  if (!body || typeof body!=="object") return refuse(["body_unparseable"]);
  const reasons=admissionRefusals(body.token,body.action);
  if (reasons.length>0) return refuse(reasons);
  // This SHA dispatches only the admitted hold-probe actions.
  try { return Response.json(await executeProbe(body.action as ProbeAction),{headers}); }
  catch { return Response.json({error: body.action === "probe-cleanup"
    ? "Cleanup was not confirmed. Retry cleanup to revalidate ownership or confirm absence."
    : "Qualification stopped. Do not retry ambiguous writes. Wait for the owned lease to expire, then clean up."},{status:503,headers}); }
};
