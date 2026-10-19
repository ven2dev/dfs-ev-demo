// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseDiscoveryFile } from "./discoveryFile.ts";
import { discoveryFor, record } from "./testSupport.ts";

const valid = () => JSON.parse(JSON.stringify(discoveryFor([record(1)])));
const codeOf = (input: unknown) => {
  try {
    parseDiscoveryFile(input);
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "accepted";
};

describe("parseDiscoveryFile", () => {
  it("accepts a real discovery file, including a rebuilt one", () => {
    const file = valid();
    expect(parseDiscoveryFile(file).creators.map((creator) => creator.key)).toEqual(["creator-a", "creator-b"]);
    expect(parseDiscoveryFile({ ...file, rebuiltAt: "2026-10-08T00:00:00.000Z" }).rebuiltAt).toBe("2026-10-08T00:00:00.000Z");
  });

  it.each([
    ["not an object", () => []],
    ["a wrong format version", () => ({ ...valid(), formatVersion: 2 })],
    ["a bad discovery time", () => ({ ...valid(), discoveredAt: "soon" })],
    ["a bad rebuilt time", () => ({ ...valid(), rebuiltAt: "later" })],
    ["no creators list", () => ({ ...valid(), creators: undefined })],
    ["a different rule version than the code's", () => ({ ...valid(), registration: { ...valid().registration, ruleVersion: "v9" } })],
    ["a duplicate creator key", () => ({ ...valid(), creators: [valid().creators[0], valid().creators[0]] })],
    ["a bad creator key", () => { const file = valid(); file.creators[0].key = "Bad Key"; return file; }],
    ["a manifest for another creator", () => { const file = valid(); file.creators[0].manifest.creatorKey = "creator-z"; return file; }],
    ["a creator without videos", () => { const file = valid(); delete file.creators[0].videos; return file; }],
    ["a video with a bad id", () => { const file = valid(); file.creators[0].videos[0].videoId = "short"; return file; }],
    ["a video missing a field", () => { const file = valid(); delete file.creators[0].videos[0].title; return file; }],
    ["a video with an unknown live state", () => { const file = valid(); file.creators[0].videos[0].liveBroadcastContent = "weird"; return file; }],
  ])("rejects %s", (_name, make) => expect(codeOf(make())).toMatch(/^(invalid-discovery-file|invalid-registration)$/));
});
