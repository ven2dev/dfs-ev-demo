-- #163 disposable proposal: a research reader over materialized features only.
-- Separate from fs138_reader so no label/normalized/raw-content grant is inherited.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='fs163_research_reader') THEN
  CREATE ROLE fs163_research_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA fs138 TO fs163_research_reader;
GRANT SELECT ON fs138.feature_values,fs138.feature_inputs,fs138.rights_decisions TO fs163_research_reader;
GRANT SELECT(snapshot_id,profile_id,job_id,deleted_at,available_at,ingested_at,evidence_basis)
 ON fs138.source_snapshots TO fs163_research_reader;
GRANT SELECT(job_id,status) ON fs138.job_runs TO fs163_research_reader;
