import { Client } from "pg";
import { API_DATA_MAX_AGE_DAYS } from "../../../../apps/web/src/lib/creatorCorpusManifest.ts";
import {
  assertConnectedCorpusTarget,
  CORPUS_LOCK_KEY,
  CORPUS_LOCK_NAMESPACE,
  CorpusImportDatabaseError,
} from "./importPublisher.ts";
import type { CorpusDatabaseConfig } from "./importTarget.ts";

export class CorpusApiExpiryError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new CorpusApiExpiryError(code);
};

export const expireCorpusApiEvidence = async ({
  config,
  now,
}: {
  config: CorpusDatabaseConfig;
  now: Date;
}) => {
  if (!Number.isFinite(now.getTime())) return fail("invalid-api-expiry-time");
  const cutoff = new Date(now.getTime() - API_DATA_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const client = new Client(config);
  try {
    try { await client.connect(); } catch { return fail("corpus-api-expiry-database-failure"); }
    try { await assertConnectedCorpusTarget(client, config); }
    catch (error) {
      if (error instanceof CorpusImportDatabaseError) throw error;
      return fail("corpus-api-expiry-database-failure");
    }
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL statement_timeout='20s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='20s'");
      await client.query("SET LOCAL search_path=public");
      const { rows: [lock] } = await client.query("SELECT pg_try_advisory_xact_lock($1,$2) AS acquired",
        [CORPUS_LOCK_NAMESPACE, CORPUS_LOCK_KEY]);
      if (!lock.acquired) return fail("corpus-api-expiry-lock-busy");
      // A creator's rows are one validated snapshot. If any row is over the
      // retention limit, delete that complete snapshot rather than leave a
      // misleading partial view.
      const { rows: [expired] } = await client.query(`WITH expired_creators AS (
          SELECT creator_key FROM corpus_api_videos GROUP BY creator_key HAVING min(api_fetched_at) < $1::timestamptz
        ), deleted AS (
          DELETE FROM corpus_api_videos AS videos USING expired_creators
          WHERE videos.creator_key=expired_creators.creator_key RETURNING videos.creator_key
        ) SELECT count(*)::integer AS "videosDeleted",count(DISTINCT creator_key)::integer AS "creatorsExpired"
          FROM deleted`, [cutoff]);
      await client.query("COMMIT");
      return {
        outcome: "expired" as const,
        cutoff,
        creatorsExpired: expired.creatorsExpired as number,
        videosDeleted: expired.videosDeleted as number,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof CorpusApiExpiryError || error instanceof CorpusImportDatabaseError) throw error;
      return fail("corpus-api-expiry-database-failure");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
};
