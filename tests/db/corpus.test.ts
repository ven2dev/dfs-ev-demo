import { expect, it } from "vitest";
import type { Client } from "pg";
import { withMigratedDatabase } from "./migrated.mts";

const NOW = "2026-10-12T06:00:00.000Z";
const CAPTURED = "2026-09-10T18:00:00.000Z";
const VIDEO = "abcdefghijk";
const HEX = (value: string) => value.repeat(64);

const withCorpusProof = async (run: (client: Client) => Promise<void>) => {
  await withMigratedDatabase(process.env, (client) => run(client));
};

const insertImport = async (client: Client) => {
  const result = await client.query(`INSERT INTO corpus_imports
    (imported_at,importer_version,rule_version,registration_fingerprint,gate_fingerprint,capture_input_fingerprint,
      decision_input_fingerprint,discovery_input_fingerprint,capture_event_count,decision_event_count,api_video_count)
    VALUES ($1,'corpus-import-v1','v1',$2,$3,$4,$5,$6,2,1,1) RETURNING import_id`,
  [NOW, HEX("1"), HEX("2"), HEX("3"), HEX("4"), HEX("5")]);
  return result.rows[0].import_id as string;
};

const insertFixture = async (client: Client) => {
  const importId = await insertImport(client);
  await client.query(`INSERT INTO corpus_gate_registrations
    (commitment_digest,commitment_algorithm,commitment_version,eligible_creator_count,
      minimum_reviewed_gradable_picks_overall,minimum_reviewed_gradable_picks_per_creator,maximum_feature_count,
      start_season,start_week,end_season,end_week,collection_season_type,rule_version,registered_at,imported_at,first_import_id)
    VALUES ($1,'sha256',1,4,500,100,10,2024,1,2026,4,'regular','v1',$2,$3,$4)`,
  [HEX("6"), "2026-10-12T05:29:00.287Z", NOW, importId]);
  for (const [position, event] of [[1, "captured"], [2, "replaced"]] as const) {
    await client.query(`INSERT INTO corpus_capture_events
      (creator_key,log_position,event_fingerprint,video_id,event_kind,published_date,published_date_precision,
        published_date_provenance,transcript_source,usage_status,caption_kind,transcript_sha256,
        transcript_characters,captured_at,first_import_id)
      VALUES ('creator-a',$1,$2,$3,$4,'2026-09-10','day','owner-confirmed-video-page-pacific-date',
        'manual-owner-paste','internal-research-only','uploaded',$5,1234,$6,$7)`,
    [position, HEX("7"), VIDEO, event, HEX("8"), CAPTURED, importId]);
  }
  await client.query(`INSERT INTO corpus_decision_events
    (creator_key,file_position,event_fingerprint,video_id,decision_kind,reason,rule_version,decided_at,first_import_id)
    VALUES ('creator-a',1,$1,$2,'exclude','Synthetic decision reason','v1',$3,$4)`,
  [HEX("9"), VIDEO, CAPTURED, importId]);
  await client.query(`INSERT INTO corpus_api_videos
    (creator_key,video_id,published_at,duration_seconds,live_broadcast_content,api_fetched_at,season,week,
      season_week_provenance,classification_status,classification_reasons,classification_rule_version,
      review_status,snapshot_import_id)
    VALUES ('creator-a',$1,'2026-09-10T17:00:00.000Z',1800,'none',$2,2026,1,
      'youtube-api-published-at.nfl-calendar-v1','candidate',ARRAY['prop-and-nfl-signal-in-title']::varchar(64)[],
      'v1','excluded',$3)`,
  [VIDEO, CAPTURED, importId]);
  return importId;
};

const rejected = async (client: Client, sql: string, expected: { code: string; message?: string }) => {
  await client.query("SAVEPOINT corpus_probe");
  try {
    await expect(client.query(sql)).rejects.toMatchObject(expected);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT corpus_probe");
  }
};

it("corpus schema stores only bounded metadata and keeps owner, API and derived statuses separate", async () => {
  await withCorpusProof(async (client) => {
    await client.query("BEGIN");
    try {
      await insertFixture(client);
      const columns = (await client.query(`SELECT table_name,column_name,data_type,character_maximum_length,udt_name
        FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'corpus\\_%' ESCAPE '\\'
        ORDER BY table_name,column_name`)).rows;
      expect(columns.length).toBeGreaterThan(40);
      expect(columns.map((row) => row.column_name)).not.toEqual(expect.arrayContaining([
        "transcript_text", "title", "description", "audio", "payload", "creator_name", "channel_name", "salt",
      ]));
      expect(columns.filter((row) => ["text", "bytea", "json", "jsonb"].includes(row.data_type))).toEqual([]);
      expect(columns.filter((row) => row.data_type === "character varying")
        .every((row) => Number(row.character_maximum_length) <= 500)).toBe(true);
      expect((await client.query(`SELECT c.event_kind,a.classification_status,a.review_status
        FROM corpus_capture_events c JOIN corpus_api_videos a USING (creator_key,video_id)
        WHERE c.log_position=1`)).rows).toEqual([
        { event_kind: "captured", classification_status: "candidate", review_status: "excluded" },
      ]);
      expect((await client.query("SELECT count(*)::integer AS count FROM corpus_capture_events WHERE transcript_sha256=$1", [HEX("8")])).rows[0].count).toBe(2);
      for (const sql of [
        `INSERT INTO corpus_capture_events (creator_key,log_position,event_fingerprint,video_id,event_kind,published_date,
          published_date_precision,published_date_provenance,transcript_source,usage_status,captured_at,first_import_id)
          SELECT 'creator-a',3,repeat('a',64),'${VIDEO}','unavailable','2026-09-10','min',
            'owner-confirmed-video-page-pacific-date','manual-owner-paste','internal-research-only','${CAPTURED}',import_id FROM corpus_imports LIMIT 1`,
        `INSERT INTO corpus_capture_events (creator_key,log_position,event_fingerprint,video_id,event_kind,published_date,
          published_date_precision,published_date_provenance,transcript_source,usage_status,captured_at,first_import_id)
          SELECT 'creator-a',3,repeat('a',64),'${VIDEO}','unavailable','2026-09-10','day',
            'owner-confirmed-video-page-pacific-date','unapproved-source','internal-research-only','${CAPTURED}',import_id FROM corpus_imports LIMIT 1`,
        `INSERT INTO corpus_api_videos (creator_key,video_id,published_at,live_broadcast_content,api_fetched_at,season,week,
          season_week_provenance,classification_status,classification_reasons,classification_rule_version,review_status,snapshot_import_id)
          SELECT 'creator-a','bbbbbbbbbbb','2026-09-10T17:00:00Z','none','${CAPTURED}',2026,NULL,
            'youtube-api-published-at.nfl-calendar-v1','candidate',ARRAY['prop-and-nfl-signal-in-title']::varchar(64)[],
            'v1','present',import_id FROM corpus_imports LIMIT 1`,
      ]) await rejected(client, sql, { code: "23514" });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

it("corpus owner events, imports and gate registrations are append-only while API rows are replace-or-delete", async () => {
  await withCorpusProof(async (client) => {
    await client.query("BEGIN");
    try {
      await insertFixture(client);
      for (const sql of [
        "UPDATE corpus_imports SET importer_version=importer_version",
        "DELETE FROM corpus_capture_events",
        "UPDATE corpus_decision_events SET reason=reason",
        "DELETE FROM corpus_gate_registrations",
        "TRUNCATE corpus_capture_events",
      ]) await rejected(client, sql, { code: "23514", message: "corpus-append-only" });
      await rejected(client, "UPDATE corpus_api_videos SET review_status='present'", {
        code: "23514", message: "corpus-api-replace-required",
      });
      await rejected(client, "TRUNCATE corpus_api_videos", {
        code: "23514", message: "corpus-api-replace-required",
      });
      await client.query("DELETE FROM corpus_api_videos WHERE creator_key='creator-a'");
      expect((await client.query("SELECT count(*)::integer AS count FROM corpus_api_videos")).rows[0].count).toBe(0);
      expect((await client.query("SELECT count(*)::integer AS count FROM corpus_capture_events")).rows[0].count).toBe(2);
      expect((await client.query("SELECT count(*)::integer AS count FROM corpus_decision_events")).rows[0].count).toBe(1);
      expect((await client.query("SELECT count(*)::integer AS count FROM corpus_gate_registrations")).rows[0].count).toBe(1);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

it("corpus importer role has only local projection privileges and PUBLIC/runtime roles have none", async () => {
  await withCorpusProof(async (client) => {
    await client.query(`DO $probe$ BEGIN CREATE ROLE corpus_runtime_probe NOLOGIN;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $probe$`);
    const functions = (await client.query(`SELECT p.proname,has_function_privilege('public',p.oid,'EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'corpus\\_%' ESCAPE '\\' ORDER BY p.proname`)).rows;
    expect(functions).toEqual([
      { proname: "corpus_api_replace_only", public_execute: false },
      { proname: "corpus_append_only", public_execute: false },
    ]);
    for (const table of ["corpus_imports", "corpus_capture_events", "corpus_decision_events", "corpus_gate_registrations"]) {
      expect((await client.query("SELECT has_table_privilege('corpus_importer',$1,'SELECT,INSERT') AS allowed", [`public.${table}`])).rows[0].allowed).toBe(true);
      expect((await client.query("SELECT has_table_privilege('corpus_importer',$1,'UPDATE,DELETE,TRUNCATE') AS allowed", [`public.${table}`])).rows[0].allowed).toBe(false);
      expect((await client.query("SELECT has_table_privilege('corpus_runtime_probe',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed", [`public.${table}`])).rows[0].allowed).toBe(false);
    }
    expect((await client.query("SELECT has_table_privilege('corpus_importer','public.corpus_api_videos','SELECT,INSERT,DELETE') AS allowed")).rows[0].allowed).toBe(true);
    expect((await client.query("SELECT has_table_privilege('corpus_importer','public.corpus_api_videos','UPDATE,TRUNCATE') AS allowed")).rows[0].allowed).toBe(false);

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE corpus_importer");
      const importId = await insertImport(client);
      await client.query(`INSERT INTO corpus_api_videos
        (creator_key,video_id,published_at,live_broadcast_content,api_fetched_at,season,week,season_week_provenance,
          classification_status,classification_reasons,classification_rule_version,review_status,snapshot_import_id)
        VALUES ('creator-a',$1,'2026-09-10T17:00:00Z','none',$2,2026,1,'youtube-api-published-at.nfl-calendar-v1',
          'candidate',ARRAY['prop-and-nfl-signal-in-title']::varchar(64)[],'v1','present',$3)`, [VIDEO, CAPTURED, importId]);
      await client.query("DELETE FROM corpus_api_videos WHERE creator_key='creator-a'");
      await expect(client.query("DELETE FROM corpus_imports")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
