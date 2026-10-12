// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseCorpusDatabaseRegistration, parseCorpusDatabaseTarget } from "./importTarget.ts";

const registration = parseCorpusDatabaseRegistration({
  formatVersion: 1,
  transport: "loopback",
  port: 55432,
  database: "dfs_ev_corpus",
  role: "corpus_importer",
});

describe("creator corpus import target", () => {
  it("accepts only the exact registered local database and dedicated role", () => {
    const config = parseCorpusDatabaseTarget({
      CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@localhost:55432/dfs_ev_corpus",
    }, registration);
    expect(config).toMatchObject({ host: "127.0.0.1", port: 55432, database: "dfs_ev_corpus", user: "corpus_importer", ssl: false });
    expect(JSON.stringify(config)).not.toContain("postgresql://");
  });

  it.each([
    ["a hosted URL", { CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@ep-example.neon.tech:5432/dfs_ev_corpus" }],
    ["a misleading database", { CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@127.0.0.1:55432/production" }],
    ["the wrong role", { CORPUS_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:55432/dfs_ev_corpus" }],
    ["URL options", { CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@127.0.0.1:55432/dfs_ev_corpus?sslmode=require" }],
    ["ordinary application configuration", {
      CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@127.0.0.1:55432/dfs_ev_corpus",
      DATABASE_URL: "postgresql://example",
    }],
    ["ambient PG configuration", {
      CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@127.0.0.1:55432/dfs_ev_corpus",
      PGHOST: "127.0.0.1",
    }],
  ])("refuses %s without reflecting credentials", (_label, environment) => {
    let error: unknown;
    try { parseCorpusDatabaseTarget(environment, registration); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: expect.stringMatching(/refused|required/) });
    expect(String(error)).not.toContain("secret");
    expect(String(error)).not.toContain("ep-example");
  });

  it("refuses loose or malformed approval records", () => {
    for (const value of [null, {}, { ...registration, role: "postgres" }, { ...registration, extra: true },
      { ...registration, port: 543 }]) {
      expect(() => parseCorpusDatabaseRegistration(value)).toThrow(
        expect.objectContaining({ code: "invalid-database-registration" })
      );
    }
  });
});
