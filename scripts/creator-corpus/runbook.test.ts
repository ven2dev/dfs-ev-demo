// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { API_DATA_MAX_AGE_DAYS } from "../../src/lib/creatorCorpusManifest.ts";
import { loadRegistration } from "./creatorInputs.ts";

// The runbook is only useful while it matches the tools, so these checks fail
// when a command, option, error code, file or fixed value drifts from it.
const root = process.cwd();
const RUNBOOK = readFileSync(resolve(root, "docs/creator-corpus-operations.md"), "utf8");
const TOOL_DIRECTORY = resolve(root, "scripts/creator-corpus");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");
const toolSources = readdirSync(TOOL_DIRECTORY)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => source(`scripts/creator-corpus/${name}`))
  .concat(source("src/lib/creatorDecisions.ts"));
const CLI = source("scripts/creator-corpus/cli.ts");

const COMMANDS = ["resolve", "confirm", "discover", "review", "rebuild", "screen", "purge"];
const OPTIONS = ["creators", "output", "max-units", "registry", "keys", "decisions", "captures", "allow-incomplete-end-week", "input", "port", "dry-run", "force"];

describe("creator corpus runbook", () => {
  it("documents every command, and every command it shows exists", () => {
    const shown = [...RUNBOOK.matchAll(/npm run creators -- ([a-z]+)/g)].map((match) => match[1]);
    expect(new Set(shown)).toEqual(new Set(COMMANDS));
    for (const command of COMMANDS) expect(CLI, command).toContain(`command === "${command}"`);
  });

  it("documents every option, and every option it shows is real", () => {
    const shown = new Set([...RUNBOOK.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]));
    for (const option of OPTIONS) {
      expect(shown.has(option), `runbook mentions --${option}`).toBe(true);
      expect(CLI.includes(`"${option}"`) || CLI.includes(`${option}: {`), `cli defines --${option}`).toBe(true);
    }
    expect([...shown].filter((option) => !OPTIONS.includes(option))).toEqual([]);
  });

  it("lists only error codes that the tools can actually print", () => {
    const table = RUNBOOK.slice(RUNBOOK.indexOf("| Code |"), RUNBOOK.indexOf("Any other code"));
    const codes = [...table.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(20);
    for (const code of codes) {
      expect(toolSources.some((text) => text.includes(`"${code}"`)), code).toBe(true);
    }
  });

  it("refers only to repository files that exist", () => {
    const paths = [...RUNBOOK.matchAll(/`((?:src|scripts|docs)\/[A-Za-z0-9_./-]+)`/g)].map((match) => match[1]);
    expect(paths).toEqual(expect.arrayContaining(["scripts/creator-corpus/registration.json", "src/lib/creatorVideoRule.ts", "src/lib/nflSeasonCalendar.ts"]));
    for (const path of paths) expect(existsSync(resolve(root, path)), path).toBe(true);
  });

  it("states the registered window, the data age limit and the default quota cap that the code uses", async () => {
    const registration = await loadRegistration();
    expect(RUNBOOK).toContain(`${registration.window.endSeason} Week ${registration.window.endWeek}`);
    expect(RUNBOOK).toContain(`**${API_DATA_MAX_AGE_DAYS} days**`);
    expect(RUNBOOK).toContain("(default 1000)");
    expect(CLI).toContain('parseUnits(values["max-units"], 1000)');
    expect(RUNBOOK).toContain("Up to 20 creators");
    expect(source("scripts/creator-corpus/creatorInputs.ts")).toContain("MAX_CREATORS = 20");
  });

  it("keeps a real API key, channel ID or creator name out of the document", () => {
    expect(RUNBOOK).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(RUNBOOK).not.toMatch(/\bUC[0-9A-Za-z_-]{22}\b/);
    expect(RUNBOOK).not.toMatch(/watch\?v=(?!VIDEO_ID_)[A-Za-z0-9_-]{11}/);
  });
});
