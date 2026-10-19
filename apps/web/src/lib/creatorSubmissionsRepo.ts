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

// Second review pass caught a deeper race the first fix (create then
// clean up afterward) didn't close: a THIRD, unrelated request can grab
// the same channel's creator id in the gap between the losing request
// creating it and that same request's own cleanup DELETE running --
// NOT EXISTS only sees submissions already committed at that instant,
// never one a concurrent request is still in flight to insert. Bundling
// creator-creation and the submission insert into one transaction isn't
// enough by itself either: under Read Committed, two concurrent
// transactions' OWN "does this URL exist yet" checks can both still see
// "no" before either commits.
//
// What actually closes it: a per-URL Postgres advisory lock, held for
// the whole transaction (auto-released at commit/rollback), serializing
// every attempt for the SAME url completely. A second concurrent
// attempt for that url can't even run ITS OWN existence check until the
// first has fully committed or rolled back -- at which point it
// correctly sees the committed row and creates nothing (no creator, no
// submission), rather than racing to create one and having to undo it
// after the fact. This needs no application-side conditional logic --
// every statement below is fixed in advance, which is exactly what this
// driver's non-interactive transaction batch can run atomically as one
// real Postgres transaction.
//
// hashtext() is only a 32-bit hash, so two DIFFERENT urls could in
// theory collide onto the same lock key -- harmless (they'd just
// briefly serialize against each other for no reason), and irrelevant
// at this tool's real scale.
export const insertSubmission = async (
  input: CreatorSubmissionInput
): Promise<InsertSubmissionResult> => {
  const sql = getSql();

  const results = await sql.transaction((txn) => [
    txn.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [input.videoUrl]),
    // No RETURNING needed here -- the submission insert below re-derives
    // the creator id itself, inside the SAME guarded query, rather than
    // trusting a value handed across from this step.
    txn.query(
      `INSERT INTO creators (channel_name)
       SELECT $1
       WHERE NOT EXISTS (SELECT 1 FROM creator_video_submissions WHERE video_url = $2)
       ON CONFLICT (channel_name) DO UPDATE SET channel_name = EXCLUDED.channel_name`,
      [input.channelName, input.videoUrl]
    ),
    txn.query(
      `INSERT INTO creator_video_submissions (creator_id, video_url, video_title, transcript_text)
       SELECT c.id, $2, $3, $4
       FROM creators c
       WHERE c.channel_name = $1
         AND NOT EXISTS (SELECT 1 FROM creator_video_submissions WHERE video_url = $2)
       RETURNING id`,
      [input.channelName, input.videoUrl, input.videoTitle ?? null, input.transcriptText]
    ),
    txn.query("SELECT id FROM creator_video_submissions WHERE video_url = $1", [input.videoUrl]),
  ]);

  const insertedRows = results[2] as { id: number }[];
  if (insertedRows[0]) {
    return { status: "inserted", id: insertedRows[0].id };
  }

  const finalRows = results[3] as { id: number }[];
  return { status: "already-submitted", id: finalRows[0].id };
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
