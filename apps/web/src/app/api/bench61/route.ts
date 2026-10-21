import { authorizeBenchmark, executeBenchmark, type BenchAction } from "@/lib/bench61";
export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = async (request: Request) => {
  const headers = { "Cache-Control": "no-store" };
  if (Number(request.headers.get("content-length")) > 1024) return new Response(null,{status:404,headers});
  let body: {token?:unknown;action?:unknown};
  try {
    const text=await request.text();
    if(text.length>1024) return new Response(null,{status:404,headers});
    body=JSON.parse(text);
  } catch { return new Response(null,{status:404,headers}); }
  if (!body || !authorizeBenchmark(body.token,body.action)) return new Response(null,{status:404,headers});
  try { return Response.json(await executeBenchmark(body.action as BenchAction),{headers}); }
  catch { return Response.json({error:"Benchmark stopped. Do not retry ambiguous writes; inspect the owned schema before cleanup."},{status:503,headers}); }
};
