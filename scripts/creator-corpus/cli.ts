import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { CreatorManifest } from "../../src/lib/creatorCorpusManifest.ts";
import {
  CommandError,
  confirmCreators,
  discoverCreator,
  formatScreenReport,
  parseRegistry,
  rebuildDiscovery,
  resolveCreators,
  screenManifests,
  type CreatorDiscovery,
} from "./commands.ts";
import { DecisionsFileError, effectiveDecisions, eventsFor, parseDecisionsFile } from "../../src/lib/creatorDecisions.ts";
import { InputError, isEndWeekClosed, loadRegistration, parseCreatorsFile } from "./creatorInputs.ts";
import { parseDiscoveryFile } from "./discoveryFile.ts";
import { readDecisionsFile } from "./decisionStore.ts";
import { PrivateFileError, assertPrivateOutputAvailable, readPrivateJson, writePrivateJson } from "./privateOutput.ts";
import { startReviewServer } from "./reviewServer.ts";
import { YoutubeApiError, createQuotaMeter, createYoutubeClient, type FetchLike } from "./youtubeApi.ts";

// Owner-run commands for the #88 corpus manifest. Failures print one fixed
// code; nothing printed here can contain the API key, a URL or a raw error.
class UsageError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const usage = (code: string): never => {
  throw new UsageError(code);
};

export type CliDeps = {
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  now: () => Date;
  out: (line: string) => void;
  // Resolves when the owner stops a long-running command (Ctrl+C).
  waitForStop: () => Promise<void>;
};

const COMMON = {
  output: { type: "string" },
  "max-units": { type: "string" },
} as const;

const parseUnits = (value: string | undefined, fallback: number): number => {
  const units = value === undefined ? fallback : Number(value);
  return Number.isInteger(units) && units >= 1 && units <= 10_000 ? units : usage("invalid-max-units");
};

const apiClient = (deps: CliDeps, maxUnits: number) => {
  const apiKey = deps.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) throw new YoutubeApiError("api-key-missing");
  const meter = createQuotaMeter(maxUnits);
  return { meter, client: createYoutubeClient({ apiKey, fetchImpl: deps.fetchImpl, meter }) };
};

const notAppliedNotice = (count: number): string =>
  `${count} decision(s) were not applied (the video is gone, was not listed, or is outside the window). ` +
  "They stay in your log and are listed with the reason under decisionsNotApplied in the output file.";

const readDecisions = (content: unknown) => {
  try {
    return parseDecisionsFile(content);
  } catch {
    return usage("invalid-decisions-file");
  }
};

export const runCli = async (argv: string[], deps: CliDeps): Promise<void> => {
  const [command, ...rest] = argv;
  const parse = <const O extends ParseArgsOptionsConfig>(options: O) => {
    try {
      return parseArgs({ args: rest, options, allowPositionals: false }).values;
    } catch {
      return usage("invalid-options");
    }
  };

  if (command === "resolve") {
    const values = parse({ ...COMMON, creators: { type: "string" } });
    if (!values.creators || !values.output) return usage("creators-and-output-required");
    const creators = parseCreatorsFile(await readPrivateJson(values.creators));
    await assertPrivateOutputAvailable(values.output);
    const { client, meter } = apiClient(deps, parseUnits(values["max-units"], 50));
    const registry = await resolveCreators(client, creators, deps.now());
    await writePrivateJson(values.output, registry);
    for (const entry of registry.creators) {
      deps.out(`${entry.key}\t${entry.titleMatch}\tstored: ${entry.name}\tchannel: ${entry.channelTitle}`);
    }
    for (const failure of registry.failures) deps.out(`${failure.key}\tFAILED\t${failure.code}`);
    deps.out(JSON.stringify({ resolved: registry.creators.length, failed: registry.failures.length, quotaUsed: meter.used }));
    return;
  }

  if (command === "confirm") {
    const values = parse({ registry: { type: "string" }, keys: { type: "string" }, output: { type: "string" } });
    if (!values.registry || !values.keys || !values.output) return usage("registry-keys-and-output-required");
    const registry = parseRegistry(await readPrivateJson(values.registry));
    await assertPrivateOutputAvailable(values.output);
    const confirmed = confirmCreators(registry, values.keys.split(",").map((key) => key.trim()));
    await writePrivateJson(values.output, confirmed);
    deps.out(JSON.stringify({ confirmed: confirmed.creators.filter((entry) => entry.confirmed).length }));
    return;
  }

  if (command === "discover") {
    const values = parse({
      ...COMMON,
      registry: { type: "string" },
      decisions: { type: "string" },
      "allow-incomplete-end-week": { type: "boolean" },
    });
    if (!values.registry || !values.output) return usage("registry-and-output-required");
    const registration = await loadRegistration();
    const now = deps.now();
    if (!isEndWeekClosed(registration.window, now) && !values["allow-incomplete-end-week"]) {
      return usage("end-week-not-closed");
    }
    const registry = parseRegistry(await readPrivateJson(values.registry));
    const confirmed = registry.creators.filter((entry) => entry.confirmed);
    if (confirmed.length === 0) return usage("no-confirmed-creators");
    const decisions = values.decisions ? readDecisions(await readPrivateJson(values.decisions)) : {};
    // A misspelled creator key must stop the run before any quota is spent.
    const registryKeys = new Set(registry.creators.map((entry) => entry.key));
    if (Object.keys(decisions).some((key) => !registryKeys.has(key))) throw new CommandError("unknown-creator-in-decisions");
    await assertPrivateOutputAvailable(values.output);
    const { client, meter } = apiClient(deps, parseUnits(values["max-units"], 1000));
    const creators: CreatorDiscovery[] = [];
    for (const entry of confirmed) {
      creators.push(
        await discoverCreator({ client, entry, window: registration.window, decisions: effectiveDecisions(eventsFor(decisions, entry.key)), now })
      );
    }
    // Decisions for creators that are in the registry but were not discovered
    // in this run are kept in the log and reported, not applied.
    const confirmedKeys = new Set(confirmed.map((entry) => entry.key));
    const decisionsNotApplied = [
      ...creators.flatMap((creator) => creator.decisionsNotApplied),
      ...Object.entries(decisions)
        .filter(([key]) => !confirmedKeys.has(key))
        .flatMap(([key, events]) =>
          effectiveDecisions(events).map((decision) => ({
            creatorKey: key,
            videoId: decision.videoId,
            why: "creator-not-discovered" as const,
          }))
        ),
    ];
    await writePrivateJson(values.output, {
      formatVersion: 1,
      discoveredAt: now.toISOString(),
      registration,
      quota: meter,
      creators,
      decisionsNotApplied,
    });
    deps.out(formatScreenReport(screenManifests(creators.map((creator) => creator.manifest))));
    if (decisionsNotApplied.length > 0) {
      deps.out(notAppliedNotice(decisionsNotApplied.length));
    }
    deps.out(JSON.stringify({ creators: creators.length, quotaUsed: meter.used, quotaLimit: meter.limit }));
    return;
  }

  if (command === "rebuild") {
    const values = parse({ input: { type: "string" }, decisions: { type: "string" }, output: { type: "string" } });
    if (!values.input || !values.decisions || !values.output) return usage("input-decisions-and-output-required");
    const discovery = parseDiscoveryFile(await readPrivateJson(values.input));
    const decisions = readDecisions(await readPrivateJson(values.decisions));
    const rebuilt = rebuildDiscovery({ discovery, decisions, now: deps.now() });
    await writePrivateJson(values.output, rebuilt);
    deps.out(formatScreenReport(screenManifests(rebuilt.creators.map((creator) => creator.manifest))));
    const skipped = rebuilt.decisionsNotApplied?.length ?? 0;
    if (skipped > 0) deps.out(notAppliedNotice(skipped));
    return;
  }

  if (command === "review") {
    const values = parse({ input: { type: "string" }, decisions: { type: "string" }, port: { type: "string" } });
    if (!values.input || !values.decisions) return usage("input-and-decisions-required");
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) return usage("invalid-port");
    const discovery = parseDiscoveryFile(await readPrivateJson(values.input));
    // Fail now, not on the first click, if the decisions path is unusable.
    await readDecisionsFile(values.decisions);
    const server = await startReviewServer({ discovery, decisionsPath: values.decisions, now: deps.now, port });
    deps.out("Open this address in your browser. It only works on this computer:");
    deps.out(server.url);
    deps.out("Press Ctrl+C to stop.");
    try {
      await deps.waitForStop();
    } finally {
      await server.close();
    }
    return;
  }

  if (command === "screen") {
    const values = parse({ input: { type: "string" } });
    if (!values.input) return usage("input-required");
    const file = (await readPrivateJson(values.input)) as { creators?: { manifest?: CreatorManifest }[] };
    if (!Array.isArray(file?.creators) || !file.creators.every((creator) => creator?.manifest)) {
      return usage("invalid-discovery-file");
    }
    deps.out(formatScreenReport(screenManifests(file.creators.map((creator) => creator.manifest as CreatorManifest))));
    return;
  }

  usage("unknown-command");
};

const KNOWN = [UsageError, InputError, PrivateFileError, CommandError, YoutubeApiError, DecisionsFileError];

export const main = async (argv: string[]): Promise<number> => {
  try {
    await runCli(argv, {
      env: process.env,
      fetchImpl: (url, init) => fetch(url, init),
      now: () => new Date(),
      out: (line) => process.stdout.write(line.endsWith("\n") ? line : line + "\n"),
      waitForStop: () =>
        new Promise<void>((resolve) => {
          process.once("SIGINT", () => resolve());
          process.once("SIGTERM", () => resolve());
        }),
    });
    return 0;
  } catch (error) {
    const known = KNOWN.some((type) => error instanceof type);
    process.stderr.write(`creator-corpus: ${known ? (error as { code: string }).code : "unexpected-failure"}\n`);
    return 1;
  }
};

// Keep readFile referenced so a future reader sees inputs are never read here
// without the private-path checks.
void readFile;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
