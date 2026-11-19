import { attachDatabasePool } from "@vercel/functions";
import { createHandler, syntheticQuota } from "@/lib/qualification220-core.mjs";
import { createQualificationQuery } from "@/lib/qualification220-pg.mjs";

export const runtime = "nodejs";
export const maxDuration = 30;

const handler = createHandler({
  env: process.env,
  queryFactory: (connection: string) => createQualificationQuery(connection, { attachPool: attachDatabasePool }),
  freeEvents: syntheticQuota,
});

export const POST = (request: Request) => handler(request);
