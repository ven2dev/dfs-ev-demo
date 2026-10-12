import type { Client } from "pg";

// Disposable/local setup only. The shared migration grants importer privileges
// only when this role already exists; hosted setup (#95) never calls this.
export const ensureCorpusImporterRole = async (client: Client): Promise<void> => {
  await client.query(`DO $harness$ BEGIN CREATE ROLE corpus_importer NOLOGIN;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $harness$`);
};
