import "server-only";

import { getSql } from "./db";

export type CreatorSubmissionInput = {
  channelName: string;
  videoUrl?: string;
  videoTitle?: string;
  transcriptText: string;
};

export type CreatorSubmissionSummary = {
  id: number;
  channelName: string;
  videoUrl: string | null;
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
  const creatorId = await getOrCreateCreatorId(input.channelName);

  // A real video_url re-submitted is a harmless no-op, reported back
  // distinctly, not an error -- checked explicitly rather than left to
  // the UNIQUE constraint, so the caller gets a clean "already-
  // submitted" result with the EXISTING row's id instead of a raw
  // constraint-violation exception. Skipped entirely when the URL isn't
  // known (undefined) -- a null video_url never conflicts with another
  // null (Postgres treats each NULL as distinct), so there's nothing to
  // check.
  if (input.videoUrl) {
    const existing = (await sql.query(
      "SELECT id FROM creator_video_submissions WHERE video_url = $1",
      [input.videoUrl]
    )) as { id: number }[];
    if (existing[0]) {
      return { status: "already-submitted", id: existing[0].id };
    }
  }

  const rows = (await sql.query(
    `INSERT INTO creator_video_submissions (creator_id, video_url, video_title, transcript_text)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [creatorId, input.videoUrl ?? null, input.videoTitle ?? null, input.transcriptText]
  )) as { id: number }[];

  return { status: "inserted", id: rows[0].id };
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
    video_url: string | null;
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
