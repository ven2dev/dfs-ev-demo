import { describe, expect, it } from "vitest";
import type { Client } from "pg";
import { withModelArtifacts, readModelArtifacts, ArtifactGovernanceError } from "../../src/featureStore/modelArtifacts.ts";
import { ModelContextError, type ModelContext } from "../../src/featureStore/modelContext.ts";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const context = () => ({ request: { playerId: "QB-A", knownAsOf: "2026-10-31T00:00:00.123456Z" },
  feature: { featureId: id }, snapshotIds: [id] }) as ModelContext;
const receipt = { checkedAt: "2026-10-31T00:00:00Z", decisions: [{ profileId: "source", decisionId: id }] };
const first = () => ({ access: { run: { runId: id }, datasets: [], artifacts: [{ slot: "descriptor", objectKey: "models/bytes", byteSize: 2 }],
  authorization: structuredClone(receipt), context: context(), history: [{ gameId: "prior", kickoff: "2024-01-01", yards: 1 }] } });

describe("shared composite/model-only private read boundary", () => {
  it("uses the same frozen scoped pins at both checks despite caller/callback mutation", async () => {
    const scope = context(), request = { runId: id, slots: ["descriptor" as const], context: scope };
    const seen: unknown[][] = [];
    const client = { query: async (...args: unknown[]) => {
      seen.push(structuredClone(args));
      return { rows: [seen.length === 1 ? first() : { access: { authorization: receipt, context: context() } }] };
    } } as unknown as Pick<Client, "query">;
    const result = await withModelArtifacts(client, { get: async () => Buffer.from("{}") }, request, input => {
      scope.snapshotIds.length = 0; scope.request.playerId = "changed"; request.runId = "changed"; request.slots.length = 0;
      input.context!.snapshotIds.length = 0; input.run.runId = "changed"; return "private-result";
    });
    expect(seen).toHaveLength(2);
    expect(seen[0][0]).toContain("authorize_model_context_read"); expect(seen[1][0]).toBe(seen[0][0]);
    const a = seen[0][1] as unknown[], b = seen[1][1] as unknown[];
    expect(a.slice(0, 2)).toEqual([id, ["descriptor"]]); expect(b.slice(0, 2)).toEqual(a.slice(0, 2));
    expect(a[2]).toBe(true); expect(b[2]).toBe(false); expect(b[3]).toBe(a[3]);
    expect(JSON.parse(a[3] as string).snapshotIds).toEqual([id]); expect(result.value).toBe("private-result");
  });
  it("model-only calls use exactly two legacy authorizations and no context", async () => {
    const seen: unknown[][] = [];
    const client = { query: async (...args: unknown[]) => {
      seen.push(args); const pins = first(); delete (pins.access as Partial<typeof pins.access>).context;
      return { rows: [seen.length === 1 ? pins : { access: { authorization: receipt } }] };
    } } as unknown as Pick<Client, "query">;
    const result = await readModelArtifacts(client, { get: async () => Buffer.from("{}") }, { runId: id, slots: ["descriptor"] });
    expect(seen).toHaveLength(2); expect(seen.every(args => String(args[0]).includes("authorize_model_read("))).toBe(true);
    expect(seen[0][1]).toEqual([id, ["descriptor"], true]); expect(seen[1][1]).toEqual([id, ["descriptor"], false]);
    expect(result).not.toHaveProperty("context");
  });
  it("refuses absent/null/unserializable scoped references without a model-only downgrade", async () => {
    let queries = 0;
    const client = { query: async () => { queries++; throw new Error("unexpected-query"); } } as unknown as Pick<Client, "query">;
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    for (const invalid of [null, "invalid", cycle, { toJSON: () => undefined }])
      await expect(readModelArtifacts(client, { get: async () => Buffer.from("{}") },
        { runId: id, slots: ["descriptor"], context: invalid as ModelContext })).rejects.toMatchObject({ code: "model-context-reference-refused" });
    expect(queries).toBe(0);
  });
  it("withholds Q2 refusals while preserving typed context errors", async () => {
    let queries = 0, delivered = false;
    const client = { query: async () => {
      if (++queries === 1) return { rows: [first()] };
      throw { code: "P2317", message: "provider text is not the contract" };
    } } as unknown as Pick<Client, "query">;
    await expect(withModelArtifacts(client, { get: async () => Buffer.from("{}") },
      { runId: id, slots: ["descriptor"], context: context() }, () => "secret")
      .then(result => { delivered = true; return result; })).rejects.toMatchObject({ code: "model-context-reference-refused" });
    expect(delivered).toBe(false); expect(queries).toBe(2);
  });
  it("maps date SQLSTATEs only for captured context reads at Q1 and Q2", async () => {
    for (const code of ["22007", "22008", "22009", "P1666"]) for (const scoped of [false, true]) for (const failAt of [1, 2]) {
      const cause = { code, message: "provider text varies" };
      const request = { runId: id, slots: ["descriptor" as const], ...(scoped ? { context: context() } : {}) };
      let queries = 0, gets = 0, delivered = false;
      const client = { query: async () => {
        if (++queries === failAt) throw cause;
        return { rows: [first()] };
      } } as unknown as Pick<Client, "query">;
      try {
        await withModelArtifacts(client, { get: async () => { gets++; return Buffer.from("{}"); } }, request, () => {
          // Error classification follows the owned scope, not the mutable request.
          if (scoped) delete request.context; else request.context = context();
          return "private";
        }).then(result => { delivered = true; return result; });
        expect.fail("SQLSTATE must refuse delivery");
      } catch (error) {
        if (code === "P1666") {
          expect(error).toBeInstanceOf(ArtifactGovernanceError);
          expect(error).toMatchObject({ code: "model-read-status-refused", cause });
        } else if (scoped) {
          expect(error).toBeInstanceOf(ModelContextError);
          expect(error).toMatchObject({ code: "model-context-request-refused", cause });
        } else {
          expect(error).toBe(cause); expect(error).not.toBeInstanceOf(ModelContextError);
        }
      }
      expect(queries).toBe(failAt); expect(gets).toBe(failAt - 1); expect(delivered).toBe(false);
    }
  });
});
