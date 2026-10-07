// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliDeps } from "./cli.ts";
import type { FetchLike } from "./youtubeApi.ts";
import { discoveryFor, record as supportRecord, vid as supportVid } from "./testSupport.ts";

const KEY = "SECRET-KEY-VALUE-123";
const vid = (n: number) => "vid" + String(n).padStart(8, "0");
const channelId = "UC" + "a".repeat(22);
const playlistId = "UU" + "a".repeat(22);
const CLOSED = new Date("2026-10-07T12:00:00Z");
const OPEN = new Date("2026-10-05T12:00:00Z");

const videoJson = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  snippet: {
    title: "NFL Week 6 Player Props",
    description: "",
    publishedAt: "2025-10-09T15:00:00Z",
    channelId,
    channelTitle: "Example Channel",
    liveBroadcastContent: "none",
    ...overrides,
  },
  contentDetails: { duration: "PT30M" },
});

// A tiny stand-in for the two YouTube endpoints, recording every request.
const fakeYoutube = (videos: Record<string, ReturnType<typeof videoJson>>, pages: { videoId: string; at: string }[][]) => {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (raw, init) => {
    const url = new URL(raw);
    calls.push({ url, headers: init.headers });
    const body = url.pathname.endsWith("/videos")
      ? { items: (url.searchParams.get("id") ?? "").split(",").flatMap((id) => (videos[id] ? [videos[id]] : [])) }
      : (() => {
          const index = url.searchParams.get("pageToken") ? Number(url.searchParams.get("pageToken")!.slice(1)) : 0;
          return {
            items: pages[index].map((page) => ({ contentDetails: { videoId: page.videoId, videoPublishedAt: page.at } })),
            ...(index + 1 < pages.length ? { nextPageToken: `P${index + 1}` } : {}),
          };
        })();
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetchImpl };
};

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "creator-corpus-cli-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const path = (name: string) => join(directory, name);
const writeJson = (name: string, value: unknown) => writeFile(path(name), JSON.stringify(value));
const readJson = async (name: string) => JSON.parse(await readFile(path(name), "utf8"));
const run = async (args: string[], overrides: Partial<CliDeps> = {}) => {
  const lines: string[] = [];
  const deps: CliDeps = {
    env: { YOUTUBE_API_KEY: KEY },
    fetchImpl: async () => {
      throw new Error("unexpected network call");
    },
    now: () => CLOSED,
    out: (line) => lines.push(line),
    ...overrides,
  };
  try {
    await runCli(args, deps);
    return { code: "ok", lines };
  } catch (error) {
    return { code: (error as { code?: string }).code ?? "unexpected-failure", lines };
  }
};
const exists = async (name: string) => stat(path(name)).then(() => true, () => false);

const creatorsFile = [{ key: "creator-a", name: "Example Channel", seedVideoId: vid(1) }];
const registryFor = (confirmed: boolean) => ({
  formatVersion: 1,
  resolvedAt: CLOSED.toISOString(),
  failures: [],
  creators: [
    {
      key: "creator-a",
      name: "Example Channel",
      seedVideoId: vid(1),
      channelId,
      channelTitle: "Example Channel",
      uploadsPlaylistId: playlistId,
      titleMatch: "exact",
      confirmed,
      apiFetchedAt: CLOSED.toISOString(),
    },
  ],
});

describe("resolve", () => {
  it("writes an unconfirmed registry, prints the name comparison, and counts quota", async () => {
    await writeJson("creators.json", creatorsFile);
    const { calls, fetchImpl } = fakeYoutube({ [vid(1)]: videoJson(vid(1)) }, [[]]);
    const result = await run(["resolve", "--creators", path("creators.json"), "--output", path("registry.json")], { fetchImpl });
    expect(result.code).toBe("ok");
    expect(result.lines[0]).toBe("creator-a\texact\tstored: Example Channel\tchannel: Example Channel");
    expect(JSON.parse(result.lines.at(-1)!)).toEqual({ resolved: 1, failed: 0, quotaUsed: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toEqual({ "x-goog-api-key": KEY });
    expect((await readJson("registry.json")).creators[0]).toMatchObject({ confirmed: false, uploadsPlaylistId: playlistId });
    expect((await stat(path("registry.json"))).mode & 0o777).toBe(0o600);
  });

  it("fails before any network call for missing options, key, bad units, a taken output or an unsafe input", async () => {
    await writeJson("creators.json", creatorsFile);
    await writeJson("taken.json", {});
    const { calls, fetchImpl } = fakeYoutube({ [vid(1)]: videoJson(vid(1)) }, [[]]);
    const base = ["resolve", "--creators", path("creators.json"), "--output", path("registry.json")];
    expect((await run(["resolve"], { fetchImpl })).code).toBe("creators-and-output-required");
    expect((await run(base, { env: {}, fetchImpl })).code).toBe("api-key-missing");
    expect((await run(base, { env: { YOUTUBE_API_KEY: "  " }, fetchImpl })).code).toBe("api-key-missing");
    expect((await run([...base, "--max-units", "0"], { fetchImpl })).code).toBe("invalid-max-units");
    expect((await run([...base, "--max-units", "abc"], { fetchImpl })).code).toBe("invalid-max-units");
    expect(
      (await run(["resolve", "--creators", path("creators.json"), "--output", path("taken.json")], { fetchImpl })).code
    ).toBe("output-exists");
    expect(
      (await run(["resolve", "--creators", join(process.cwd(), "package.json"), "--output", path("r.json")], { fetchImpl })).code
    ).toBe("must-be-outside-repository");
    expect((await run([...base, "--bogus"], { fetchImpl })).code).toBe("invalid-options");
    // Each refusal above must happen before the API is touched, so none can spend quota.
    expect(calls).toHaveLength(0);
    expect(await exists("registry.json")).toBe(false);
  });

  it("stops the whole run at the unit cap and writes no registry", async () => {
    await writeJson("creators.json", [
      { key: "creator-a", name: "Example Channel", seedVideoId: vid(1) },
      { key: "creator-b", name: "Other Channel", seedVideoId: vid(2) },
    ]);
    const { calls, fetchImpl } = fakeYoutube(
      { [vid(1)]: videoJson(vid(1)), [vid(2)]: videoJson(vid(2), { channelId: "UC" + "b".repeat(22) }) },
      [[]]
    );
    const result = await run(
      ["resolve", "--creators", path("creators.json"), "--output", path("registry.json"), "--max-units", "1"],
      { fetchImpl }
    );
    expect(result.code).toBe("quota-limit-reached");
    expect(calls).toHaveLength(1);
    expect(await exists("registry.json")).toBe(false);
  });
});

describe("confirm", () => {
  it("writes a new registry with only the named creators confirmed and never overwrites", async () => {
    await writeJson("registry.json", registryFor(false));
    const args = ["confirm", "--registry", path("registry.json"), "--keys", "creator-a", "--output", path("confirmed.json")];
    expect((await run(args)).code).toBe("ok");
    expect((await readJson("confirmed.json")).creators[0].confirmed).toBe(true);
    expect((await readJson("registry.json")).creators[0].confirmed).toBe(false);
    expect((await run(args)).code).toBe("output-exists");
    expect((await run(["confirm", "--registry", path("registry.json"), "--keys", "nobody", "--output", path("x.json")])).code).toBe(
      "unknown-creator-key"
    );
  });
});

describe("discover", () => {
  const pages = [[{ videoId: vid(2), at: "2025-10-09T15:00:00Z" }]];
  const videos = { [vid(2)]: videoJson(vid(2)) };
  const args = (extra: string[] = []) => ["discover", "--registry", path("registry.json"), "--output", path("discovery.json"), ...extra];

  it("refuses to run before the registered end week has closed, unless explicitly overridden", async () => {
    await writeJson("registry.json", registryFor(true));
    const { calls, fetchImpl } = fakeYoutube(videos, pages);
    expect((await run(args(), { fetchImpl, now: () => OPEN })).code).toBe("end-week-not-closed");
    expect(calls).toHaveLength(0);
    expect((await run(args(["--allow-incomplete-end-week"]), { fetchImpl, now: () => OPEN })).code).toBe("ok");
  });

  it("requires a confirmed creator", async () => {
    await writeJson("registry.json", registryFor(false));
    const { calls, fetchImpl } = fakeYoutube(videos, pages);
    expect((await run(args(), { fetchImpl })).code).toBe("no-confirmed-creators");
    expect(calls).toHaveLength(0);
  });

  it("writes the manifest with quota used and prints the coverage table", async () => {
    await writeJson("registry.json", registryFor(true));
    const { calls, fetchImpl } = fakeYoutube(videos, pages);
    const result = await run(args(), { fetchImpl });
    expect(result.code).toBe("ok");
    const file = await readJson("discovery.json");
    expect(file.registration.window).toEqual({ endSeason: 2026, endWeek: 4 });
    expect(file.quota).toEqual({ limit: 1000, used: 2, byEndpoint: { "videos.list": 1, "playlistItems.list": 1 } });
    expect(file.creators[0].manifest.summary.slots).toEqual({ present: 1, "needs-review": 0, missing: 39 });
    expect(result.lines[0]).toMatch(/^creator\s+weeks/);
    expect(JSON.parse(result.lines.at(-1)!)).toEqual({ creators: 1, quotaUsed: 2, quotaLimit: 1000 });
    expect(calls.map((call) => call.url.pathname.split("/").pop())).toEqual(["playlistItems", "videos"]);
  });

  it("stops at the hard unit cap without writing a partial file", async () => {
    await writeJson("registry.json", registryFor(true));
    const { calls, fetchImpl } = fakeYoutube(videos, pages);
    expect((await run(args(["--max-units", "1"]), { fetchImpl })).code).toBe("quota-limit-reached");
    expect(calls).toHaveLength(1);
    expect(await exists("discovery.json")).toBe(false);
  });

  it("applies owner decisions from a private decisions file", async () => {
    await writeJson("registry.json", registryFor(true));
    await writeJson("decisions.json", {
      "creator-a": [
        { videoId: vid(2), decision: "exclude", reason: "recap only", ruleVersion: "v1", decidedAt: "2026-10-07T13:00:00.000Z" },
      ],
    });
    const { fetchImpl } = fakeYoutube(videos, pages);
    expect((await run(args(["--decisions", path("decisions.json")]), { fetchImpl })).code).toBe("ok");
    const [video] = (await readJson("discovery.json")).creators[0].manifest.videos;
    expect(video).toMatchObject({ status: "excluded", decision: { decision: "exclude" } });
  });
});

describe("rebuild", () => {
  const decision = (overrides: Record<string, unknown> = {}) => ({
    videoId: supportVid(1),
    decision: "include",
    reason: "props throughout",
    ruleVersion: "v1",
    decidedAt: "2026-10-07T13:00:00.000Z",
    ...overrides,
  });
  const rebuildArgs = (output = "rebuilt.json") => [
    "rebuild", "--input", path("discovery.json"), "--decisions", path("decisions.json"), "--output", path(output),
  ];
  const seed = async (decisions: unknown = { "creator-a": [decision()] }) => {
    await writeJson("discovery.json", discoveryFor([supportRecord(1)]));
    await writeJson("decisions.json", decisions);
  };

  it("applies decisions without any network call and writes a private, screenable file", async () => {
    await seed();
    let calls = 0;
    const result = await run(rebuildArgs(), { fetchImpl: async () => { calls++; throw new Error("no network allowed"); } });
    expect(result.code).toBe("ok");
    expect(calls).toBe(0);
    const rebuilt = await readJson("rebuilt.json");
    expect(rebuilt.rebuiltAt).toBe(CLOSED.toISOString());
    expect(rebuilt.creators[0].manifest.videos[0]).toMatchObject({ status: "present", decision: { decision: "include" } });
    expect((await stat(path("rebuilt.json"))).mode & 0o777).toBe(0o600);
    expect(result.lines[0]).toMatch(/^creator\s+weeks/);
    expect((await run(["screen", "--input", path("rebuilt.json")])).code).toBe("ok");
  });

  it("refuses to overwrite an existing output and requires every path", async () => {
    await seed();
    await writeJson("rebuilt.json", { keep: true });
    expect((await run(rebuildArgs())).code).toBe("output-exists");
    expect(await readJson("rebuilt.json")).toEqual({ keep: true });
    expect((await run(["rebuild", "--input", path("discovery.json")])).code).toBe("input-decisions-and-output-required");
  });

  it("fails with fixed codes for stale data, bad decisions files, unknown creators and uncounted decisions", async () => {
    await seed();
    expect((await run(rebuildArgs("a.json"), { now: () => new Date("2027-01-01T00:00:00Z") })).code).toBe("stale-discovery-data");
    expect(await exists("a.json")).toBe(false);

    await writeFile(path("decisions.json"), JSON.stringify({ "creator-a": [{ videoId: supportVid(1), decision: "include", reason: "old format" }] }));
    expect((await run(rebuildArgs("b.json"))).code).toBe("invalid-decisions-file");

    await writeJson("decisions.json", { "creator-z": [decision()] });
    expect((await run(rebuildArgs("c.json"))).code).toBe("unknown-creator-in-decisions");

    await writeJson("decisions.json", { "creator-a": [decision({ videoId: supportVid(55) })] });
    expect((await run(rebuildArgs("d.json"))).code).toBe("invalid-decisions-present");
    for (const name of ["b.json", "c.json", "d.json"]) expect(await exists(name)).toBe(false);
  });

  it("rejects a file that is not a discovery file", async () => {
    await writeJson("discovery.json", { creators: [] });
    await writeJson("decisions.json", {});
    expect((await run(rebuildArgs())).code).toBe("invalid-discovery-file");
  });
});

describe("discover with an event-log decisions file", () => {
  it("honors the latest active decision and ignores a cleared one", async () => {
    await writeJson("registry.json", registryFor(true));
    const pages = [[{ videoId: vid(2), at: "2025-10-09T15:00:00Z" }]];
    const videos = { [vid(2)]: videoJson(vid(2), { title: "NFL Week 6 best bets" }) };
    const event = (decisionKind: string, at: string) => ({
      videoId: vid(2), decision: decisionKind, reason: "reason", ruleVersion: "v1", decidedAt: at,
    });
    await writeJson("decisions.json", {
      "creator-a": [event("exclude", "2026-10-07T10:00:00.000Z"), event("clear", "2026-10-07T11:00:00.000Z")],
    });
    const { fetchImpl } = fakeYoutube(videos, pages);
    await run(["discover", "--registry", path("registry.json"), "--output", path("d1.json"), "--decisions", path("decisions.json")], { fetchImpl });
    expect((await readJson("d1.json")).creators[0].manifest.videos[0]).toMatchObject({ status: "needs-review", decision: null });
  });
});

describe("screen and dispatch", () => {
  it("prints coverage from a discovery file and refuses other files", async () => {
    await writeJson("registry.json", registryFor(true));
    const { fetchImpl } = fakeYoutube({ [vid(2)]: videoJson(vid(2)) }, [[{ videoId: vid(2), at: "2025-10-09T15:00:00Z" }]]);
    await run(["discover", "--registry", path("registry.json"), "--output", path("discovery.json")], { fetchImpl });
    const result = await run(["screen", "--input", path("discovery.json")]);
    expect(result.code).toBe("ok");
    expect(result.lines[0]).toContain("creator-a");
    await writeJson("other.json", { creators: [{}] });
    expect((await run(["screen", "--input", path("other.json")])).code).toBe("invalid-discovery-file");
    expect((await run(["screen"])).code).toBe("input-required");
  });

  it("rejects an unknown command", async () => {
    expect((await run(["frobnicate"])).code).toBe("unknown-command");
    expect((await run([])).code).toBe("unknown-command");
  });
});

describe("the real command line", () => {
  const cli = (args: string[], env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/creator-corpus/cli.ts", ...args],
      { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" }
    );

  it("prints one fixed code and never the key, for a missing key or an unusable output directory", async () => {
    await writeJson("creators.json", creatorsFile);
    const noKey = cli(["resolve", "--creators", path("creators.json"), "--output", path("registry.json")], {});
    expect(noKey.status).toBe(1);
    expect(noKey.stdout).toBe("");
    expect(noKey.stderr).toBe("creator-corpus: api-key-missing\n");

    const badDirectory = cli(
      ["resolve", "--creators", path("creators.json"), "--output", path("missing-dir/registry.json")],
      { YOUTUBE_API_KEY: KEY }
    );
    expect(badDirectory.status).toBe(1);
    expect(badDirectory.stderr).toBe("creator-corpus: directory-missing\n");
    expect(badDirectory.stderr + badDirectory.stdout).not.toContain(KEY);
  });

  it("reports an unrecognised failure generically", () => {
    const result = cli(["screen", "--input", join(directory, "nope.json")], {});
    expect(result.stderr).toBe("creator-corpus: input-unreadable\n");
  });
});
