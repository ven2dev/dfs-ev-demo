import fs from "node:fs";
import fsp from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { checkConfigurationAlignment } from "../scripts/security/secrets-inventory.mjs";

const counters = vi.hoisted(() => ({ inputReads: 0, parserCalls: 0, sdkCalls: 0, sqlCalls: 0, networkCalls: 0, privateDotenvReads: 0 }));
vi.mock("firebase-admin/app", () => ({
  cert: () => { counters.sdkCalls++; throw new Error("Unexpected synthetic SDK call."); },
  initializeApp: () => { counters.sdkCalls++; throw new Error("Unexpected synthetic SDK call."); },
}));
vi.mock("pg", async original => ({ ...await original<typeof import("pg")>(),
  Pool: function () { counters.sqlCalls++; throw new Error("Unexpected synthetic database initialization."); },
}));

describe("value-free executable definition import", () => {
  it("loads the real modules with traps active, without reading inputs or starting clients", async () => {
    expect(process.env.SYNTHETIC_DOTENV_287).toBeUndefined();
    const originalProcess = process;
    const reads: string[] = [];
    const privateDotenv = (path: unknown) => /(?:^|[/\\])\.env(?:\.[^/\\]+)?$/.test(String(path));
    const readFileSync = fs.readFileSync;
    const readFile = fsp.readFile;
    const sync = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (privateDotenv(args[0])) { counters.privateDotenvReads++; throw new Error("Private dotenv read refused."); }
      return readFileSync(...args);
    });
    const asyncRead = vi.spyOn(fsp, "readFile").mockImplementation((...args) => {
      if (privateDotenv(args[0])) { counters.privateDotenvReads++; throw new Error("Private dotenv read refused."); }
      return readFile(...args);
    });
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      counters.networkCalls++; throw new Error("Unexpected synthetic network call.");
    });
    vi.stubGlobal("process", { ...originalProcess, env: new Proxy(originalProcess.env, {
      get(target, property) {
        reads.push(String(property));
        return Reflect.get(target, property);
      },
    }) });
    try {
      vi.resetModules();
      const server = await import("../apps/web/src/lib/config.server");
      const client = await import("../apps/web/src/lib/config.client");
      const definitions = { ...server.serverInputDefinitions, ...client.publicInputDefinitions };
      counters.inputReads = reads.filter(name => Object.hasOwn(definitions, name)).length;
      const parsers = Object.values(definitions).map(definition => vi.spyOn(definition, "parse").mockImplementation(() => {
        counters.parserCalls++; throw new Error("Unexpected parser execution.");
      }));
      const read = () => { counters.inputReads++; throw new Error("Unexpected synthetic input read."); };
      server.createServerConfig(read, { firebaseProjectId: read });
      client.createPublicConfig(read);
      const catalog = JSON.parse(fs.readFileSync(new URL("../docs/secrets-inventory.json", import.meta.url), "utf8"));
      const alignment = checkConfigurationAlignment(catalog, {
        server: server.serverInputDefinitions, client: client.publicInputDefinitions,
      });
      counters.inputReads = reads.filter(name => Object.hasOwn(definitions, name)).length;
      for (const parser of parsers) expect(parser).not.toHaveBeenCalled();
      expect(counters).toEqual({ inputReads: 0, parserCalls: 0, sdkCalls: 0, sqlCalls: 0, networkCalls: 0, privateDotenvReads: 0 });
      console.info("CONFIGURATION_IMPORT_PROBE " + JSON.stringify({ ...counters,
        alignment,
        serverInputs: Object.keys(server.serverInputDefinitions).length,
        clientInputs: Object.keys(client.publicInputDefinitions).length }));
    } finally {
      vi.unstubAllGlobals();
      sync.mockRestore(); asyncRead.mockRestore(); network.mockRestore();
      vi.restoreAllMocks();
    }
  });
});
