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
  it.each([
    ["localhost", "postgresql://corpus_importer:secret@localhost:55432/dfs_ev_corpus", "127.0.0.1"],
    ["canonical IPv4", "postgresql://corpus_importer:secret@127.0.0.1:55432/dfs_ev_corpus", "127.0.0.1"],
    ["expanded IPv6 loopback", "postgresql://corpus_importer:secret@[0:0:0:0:0:0:0:1]:55432/dfs_ev_corpus", "::1"],
    ["an encoded exact database name", "postgresql://corpus_importer:secret@127.0.0.1:55432/dfs_ev_%63orpus", "127.0.0.1"],
  ])("accepts the exact registered target through %s", (_label, url, host) => {
    const config = parseCorpusDatabaseTarget({
      CORPUS_DATABASE_URL: url,
    }, registration);
    expect(config).toMatchObject({ host, port: 55432, database: "dfs_ev_corpus", user: "corpus_importer", ssl: false });
    expect(JSON.stringify(config)).not.toContain("postgresql://");
  });

  it.each([
    ["a hosted URL", { CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@ep-example.neon.tech:5432/dfs_ev_corpus" }],
    ["userinfo that disguises a hosted URL", {
      CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret%40127.0.0.1@ep-example.neon.tech:55432/dfs_ev_corpus",
    }],
    ["another IPv4 loopback address", {
      CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@127.0.0.2:55432/dfs_ev_corpus",
    }],
    ["a hexadecimal IPv4 spelling", {
      CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@0x7f000001:55432/dfs_ev_corpus",
    }],
    ["a misleading database", { CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@127.0.0.1:55432/production" }],
    ["an encoded misleading database", {
      CORPUS_DATABASE_URL: "postgresql://corpus_importer:secret@127.0.0.1:55432/%70roduction",
    }],
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
