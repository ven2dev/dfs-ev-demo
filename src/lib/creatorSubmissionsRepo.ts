import "server-only";

import { getSql } from "./db";

export type CreatorSubmissionInput = {
  channelName: string;
  // Required (2026-09-29 revision) -- it's the only real dedup key, and
  // #35/#36 need a real source link. videoTitle stays optional.
  videoUrl: string;
  videoTitle?: string;
  transcriptText: string;
};

export type CreatorSubmissionSummary = {
  id: number;
  channelName: string;
  videoUrl: string;
  videoTitle: string | null;
  submittedAt: string;
};

export type InsertSubmissionResult =
  | { status: "inserted"; id: number }
  | { status: "already-submitted"; id: number };

// "DO UPDATE SET channel_name = EXCLUDED.channel_name" (a no-op update)
// rather than "DO NOTHING" -- RETURNING only yields rows an INSERT or
// UPDATE actually touched, and DO NOTHING touches zero rows on a
// conflict. This is the standard Postgres idiom for "insert-or-get,
// always get the row back" in one round trip.
const getOrCreateCreatorId = async (channelName: string): Promise<number> => {
  const sql = getSql();
  const rows = (await sql.query(
    `INSERT INTO creators (channel_name)
     VALUES ($1)
     ON CONFLICT (channel_name) DO UPDATE SET channel_name = EXCLUDED.channel_name
     RETURNING id`,
    [channelName]
  )) as { id: number }[];
  return rows[0].id;
};

export const insertSubmission = async (
  input: CreatorSubmissionInput
): Promise<InsertSubmissionResult> => {
  const sql = getSql();

  // First-pass check, not what makes this race-safe by itself -- it
  // just avoids creating a creator row for the COMMON case of an
  // obvious duplicate (caught in review: creating the creator before
  // this check meant re-submitting a known URL under a brand-new
  // channel name silently created an orphaned creator with zero
  // submissions). The actual race-safety comes from the ON CONFLICT
  // below.
  const existing = (await sql.query(
    "SELECT id FROM creator_video_submissions WHERE video_url = $1",
    [input.videoUrl]
  )) as { id: number }[];
  if (existing[0]) {
    return { status: "already-submitted", id: existing[0].id };
  }

  const creatorId = await getOrCreateCreatorId(input.channelName);

  // ON CONFLICT DO NOTHING makes the insert itself atomic against a
  // genuinely concurrent duplicate submission -- two requests can both
  // pass the check above before either has inserted (a real race the
  // check alone can't close), and without this the second one would
  // throw on the UNIQUE constraint and surface as a raw 500 instead of
  // the same clean "already-submitted" result.
  const rows = (await sql.query(
    `INSERT INTO creator_video_submissions (creator_id, video_url, video_title, transcript_text)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (video_url) DO NOTHING
     RETURNING id`,
    [creatorId, input.videoUrl, input.videoTitle ?? null, input.transcriptText]
  )) as { id: number }[];

  if (rows[0]) {
    return { status: "inserted", id: rows[0].id };
  }

  // Lost the race -- some concurrent request's insert won, using ITS
  // OWN creator_id, not this one. This request's own getOrCreateCreatorId
  // call above may have just created a brand-new creator row that will
  // now never get a submission (caught in review). A real transactional
  // rollback isn't available here -- this project's Postgres client
  // (@neondatabase/serverless's `neon()`) only runs a fixed, predetermined
  // batch of queries as one atomic unit; it has no interactive session to
  // conditionally ROLLBACK mid-flight, and switching to the stateful
  // Pool/Client class just for this one edge case is a real architecture
  // change, not a proportionate fix here. Deleting the row afterward
  // reaches the same end state (no orphan survives) instead: the
  // NOT EXISTS guard makes this safe to run unconditionally -- a creator
  // that already had OTHER submissions (an existing channel, not a
  // brand-new one) is protected and never touched, and this is itself a
  // single atomic statement, race-safe on its own.
  await sql.query(
    `DELETE FROM creators
     WHERE id = $1 AND NOT EXISTS (
       SELECT 1 FROM creator_video_submissions WHERE creator_id = $1
     )`,
    [creatorId]
  );

  const winner = (await sql.query(
    "SELECT id FROM creator_video_submissions WHERE video_url = $1",
    [input.videoUrl]
  )) as { id: number }[];
  return { status: "already-submitted", id: winner[0].id };
};

// Deliberately excludes transcript_text -- this is a lightweight "what's
// already been submitted" browse list, not a full-transcript dump.
export const listSubmissions = async (limit = 50): Promise<CreatorSubmissionSummary[]> => {
  const sql = getSql();
  const rows = (await sql.query(
    `SELECT s.id, c.channel_name, s.video_url, s.video_title, s.submitted_at
     FROM creator_video_submissions s
     JOIN creators c ON c.id = s.creator_id
     ORDER BY s.submitted_at DESC
     LIMIT $1`,
    [limit]
  )) as {
    id: number;
    channel_name: string;
    video_url: string;
    video_title: string | null;
    submitted_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    channelName: row.channel_name,
    videoUrl: row.video_url,
    videoTitle: row.video_title,
    submittedAt: row.submitted_at,
  }));
};
