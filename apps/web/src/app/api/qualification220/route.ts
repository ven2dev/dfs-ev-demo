import { neon } from "@neondatabase/serverless";
import { createHandler } from "@/lib/qualification220-core.mjs";

export const runtime = "nodejs";
export const maxDuration = 30;

const handler = createHandler({
  env: process.env,
  queryFactory: (connection: string) => {
    const sql = neon(connection);
    return (text: string, parameters: unknown[]) => sql.query(text, parameters);
  },
  freeEvents: async () => {
    const key = process.env.SPIKE220_ODDS_API_KEY;
    if (!key) throw new Error("Free quota observation is not configured");
    const url = new URL("https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events");
    url.searchParams.set("apiKey", key);
    const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("Free quota observation failed");
    const value = (name: string) => {
      const raw = response.headers.get(name);
      if (raw === null || raw.trim() === "") return null;
      const n = Number(raw);
      return Number.isSafeInteger(n) && n >= 0 && n <= 2147483647 ? n : null;
    };
    // Body is unnecessary for quota. Never return URL, headers or key to the caller.
    await response.body?.cancel();
    return { remaining: value("x-requests-remaining"), used: value("x-requests-used"),
      last: value("x-requests-last"), observed: new Date().toISOString() };
  },
});
export const POST = (request: Request) => handler(request);
