import { authorizeFunctional, executeFunctional, type FunctionalAction } from "@/lib/bench61-functional";
export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = async (request: Request) => {
  const headers = { "Cache-Control": "no-store" };
  if (Number(request.headers.get("content-length")) > 1024) return new Response(null,{status:404,headers});
  let body: {token?:unknown;action?:unknown};
  try {
    const text=await request.text();
    if(text.length>1024) return new Response(null,{status:404,headers});
    body=JSON.parse(text);
  } catch { return new Response(null,{status:404,headers}); }
  if (!body || !authorizeFunctional(body.token,body.action)) return new Response(null,{status:404,headers});
  try { return Response.json(await executeFunctional(body.action as FunctionalAction),{headers}); }
  catch { return Response.json({error: body.action === "cleanup"
    ? "Cleanup was not confirmed. Retry cleanup to revalidate ownership or confirm absence."
    : "Qualification stopped. Do not retry ambiguous writes. Wait for the owned lease to expire, then clean up."},{status:503,headers}); }
};
