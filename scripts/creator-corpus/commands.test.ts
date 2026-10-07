// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RegisteredWindow } from "../../src/lib/creatorVideoRule.ts";
import {
  CommandError,
  compareChannelTitle,
  rebuildDiscovery,
  confirmCreators,
  discoverCreator,
  formatScreenReport,
  parseRegistry,
  resolveCreators,
  screenManifests,
  type RegistryEntry,
} from "./commands.ts";
import type { DecisionEvent } from "../../src/lib/creatorDecisions.ts";
import { YoutubeApiError, type ApiVideo, type UploadItem, type YoutubeClient } from "./youtubeApi.ts";
import { discoveryFor, record, vid as supportVid } from "./testSupport.ts";

const NOW = new Date("2026-10-07T12:00:00Z");
const WINDOW: RegisteredWindow = { endSeason: 2026, endWeek: 4 };
const channel = (letter: string) => "UC" + letter.repeat(22);
const vid = (n: number) => "vid" + String(n).padStart(8, "0");

const apiVideo = (id: string, overrides: Partial<ApiVideo> = {}): ApiVideo => ({
  videoId: id,
  title: "NFL Week 6 Player Props",
  description: "",
  publishedAt: "2025-10-09T15:00:00Z",
  channelId: channel("a"),
  channelTitle: "Example Channel",
  liveBroadcastContent: "none",
  durationSeconds: 1800,
  ...overrides,
});

const fakeClient = (options: {
  videos?: Record<string, ApiVideo>;
  pages?: { items: UploadItem[]; nextPageToken: string | null }[];
  throwOn?: Record<string, YoutubeApiError>;
}) => {
  const videoCalls: string[][] = [];
  const pageRequests: (string | null)[] = [];
  const client: YoutubeClient = {
    getVideos: async (ids) => {
      videoCalls.push([...ids]);
      for (const id of ids) if (options.throwOn?.[id]) throw options.throwOn[id];
      return ids.flatMap((id) => (options.videos?.[id] ? [options.videos[id]] : []));
    },
    getUploadsPage: async (_playlist, token = null) => {
      pageRequests.push(token);
      return options.pages?.[pageRequests.length - 1] ?? { items: [], nextPageToken: null };
    },
  };
  return { client, videoCalls, pageRequests };
};

describe("compareChannelTitle", () => {
  it.each([
    ["Land Example", "land example", "exact"],
    ["Land Example!", "Land  Example", "normalized"],
    ["Example Channel Sports Betting", "Example Channel", "partial"],
    ["Totally Different", "Example Channel", "mismatch"],
    ["!!!", "???", "mismatch"],
  ])("%s vs %s is %s", (stored, title, expected) => expect(compareChannelTitle(stored, title)).toBe(expected));
});

describe("resolveCreators", () => {
  const creators = [
    { key: "a", name: "Example Channel", seedVideoId: vid(1) },
    { key: "b", name: "Other Name", seedVideoId: vid(2) },
  ];

  it("turns each seed video into an unconfirmed channel identity with its uploads playlist", async () => {
    const { client } = fakeClient({
      videos: {
        [vid(1)]: apiVideo(vid(1), { channelId: channel("a"), channelTitle: "Example Channel" }),
        [vid(2)]: apiVideo(vid(2), { channelId: channel("b"), channelTitle: "Something Else" }),
      },
    });
    const registry = await resolveCreators(client, creators, NOW);
    expect(registry.creators).toEqual([
      {
        key: "a",
        name: "Example Channel",
        seedVideoId: vid(1),
        channelId: channel("a"),
        channelTitle: "Example Channel",
        uploadsPlaylistId: "UU" + "a".repeat(22),
        titleMatch: "exact",
        confirmed: false,
        apiFetchedAt: NOW.toISOString(),
      },
      expect.objectContaining({ key: "b", titleMatch: "mismatch", confirmed: false, uploadsPlaylistId: "UU" + "b".repeat(22) }),
    ]);
    expect(registry.failures).toEqual([]);
  });

  it("records per-creator failures without stopping the run", async () => {
    const { client } = fakeClient({
      videos: {
        [vid(1)]: apiVideo(vid(1), { channelId: channel("a") }),
        [vid(3)]: apiVideo(vid(3), { channelId: channel("a") }),
        [vid(4)]: apiVideo(vid(4), { channelId: "not-a-channel" }),
      },
      throwOn: { [vid(5)]: new YoutubeApiError("bad-request") },
    });
    const registry = await resolveCreators(
      client,
      [
        { key: "a", name: "x", seedVideoId: vid(1) },
        { key: "missing", name: "x", seedVideoId: vid(2) },
        { key: "dup", name: "x", seedVideoId: vid(3) },
        { key: "weird", name: "x", seedVideoId: vid(4) },
        { key: "broken", name: "x", seedVideoId: vid(5) },
      ],
      NOW
    );
    expect(registry.creators.map((entry) => entry.key)).toEqual(["a"]);
    expect(registry.failures).toEqual([
      { key: "missing", code: "seed-video-not-found" },
      { key: "dup", code: "duplicate-channel" },
      { key: "weird", code: "invalid-response" },
      { key: "broken", code: "bad-request" },
    ]);
  });

  it("stops the whole run on a quota or key failure instead of recording it per creator", async () => {
    for (const code of ["quota-limit-reached", "quota-exceeded", "forbidden", "api-key-missing"] as const) {
      const { client } = fakeClient({ throwOn: { [vid(1)]: new YoutubeApiError(code) } });
      await expect(resolveCreators(client, creators, NOW)).rejects.toMatchObject({ code });
    }
  });
});

describe("confirmCreators and parseRegistry", () => {
  const entry = (key: string, titleMatch: RegistryEntry["titleMatch"]): RegistryEntry => ({
    key,
    name: "n",
    seedVideoId: vid(1),
    channelId: channel("a"),
    channelTitle: "t",
    uploadsPlaylistId: "UU" + "a".repeat(22),
    titleMatch,
    confirmed: false,
    apiFetchedAt: NOW.toISOString(),
  });
  const registry = { formatVersion: 1 as const, resolvedAt: NOW.toISOString(), failures: [], creators: [entry("a", "exact"), entry("b", "partial"), entry("c", "mismatch")] };

  it("confirms only the named creators and leaves the input untouched", () => {
    const result = confirmCreators(registry, ["a", "b"]);
    expect(result.creators.map((creator) => creator.confirmed)).toEqual([true, true, false]);
    expect(registry.creators.every((creator) => !creator.confirmed)).toBe(true);
  });

  it("refuses unknown keys, duplicate or empty key lists, and title mismatches", () => {
    const code = (keys: string[]) => {
      try {
        confirmCreators(registry, keys);
      } catch (error) {
        expect(error).toBeInstanceOf(CommandError);
        return (error as CommandError).code;
      }
      return "accepted";
    };
    expect(code(["zzz"])).toBe("unknown-creator-key");
    expect(code(["a", "a"])).toBe("invalid-confirm-keys");
    expect(code([])).toBe("invalid-confirm-keys");
    expect(code(["c"])).toBe("title-mismatch-cannot-confirm");
  });

  it("rejects a registry whose uploads playlist does not follow from its channel", () => {
    expect(parseRegistry(registry)).toBe(registry);
    const tampered = { ...registry, creators: [{ ...entry("a", "exact"), uploadsPlaylistId: "UU" + "z".repeat(22) }] };
    expect(() => parseRegistry(tampered)).toThrow(expect.objectContaining({ code: "invalid-registry" }));
    expect(() => parseRegistry(null)).toThrow();
    expect(() => parseRegistry({ ...registry, formatVersion: 2 })).toThrow();
  });
});

describe("discoverCreator", () => {
  const entry: RegistryEntry = {
    key: "a",
    name: "n",
    seedVideoId: vid(1),
    channelId: channel("a"),
    channelTitle: "Example Channel",
    uploadsPlaylistId: "UU" + "a".repeat(22),
    titleMatch: "exact",
    confirmed: true,
    apiFetchedAt: NOW.toISOString(),
  };
  const item = (n: number, publishedAt: string | null): UploadItem => ({ videoId: vid(n), publishedAt });

  it("enriches only videos inside the registered window and builds the manifest", async () => {
    const { client, videoCalls } = fakeClient({
      pages: [
        {
          items: [item(1, "2026-10-10T00:00:00Z"), item(2, "2025-10-09T15:00:00Z"), item(3, "2024-05-01T00:00:00Z")],
          nextPageToken: null,
        },
      ],
      videos: { [vid(2)]: apiVideo(vid(2)) },
    });
    const result = await discoverCreator({ client, entry, window: WINDOW, now: NOW });
    expect(videoCalls).toEqual([[vid(2)]]);
    expect(result.enrichedVideos).toBe(1);
    expect(result.manifest.slots.find((slot) => slot.season === 2025 && slot.week === 6)).toMatchObject({
      status: "present",
      videoIds: [vid(2)],
    });
    expect(result.videos[0].apiFetchedAt).toBe(NOW.toISOString());
  });

  it("fetches in batches of at most 50 and reports videos the API no longer returns", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => index + 1);
    const { client, videoCalls } = fakeClient({
      pages: [{ items: ids.map((n) => item(n, "2025-10-09T15:00:00Z")), nextPageToken: null }],
      videos: Object.fromEntries(ids.filter((n) => n !== 7).map((n) => [vid(n), apiVideo(vid(n))])),
    });
    const result = await discoverCreator({ client, entry, window: WINDOW, now: NOW });
    expect(videoCalls.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(result.unavailableVideoIds).toEqual([vid(7)]);
    expect(result.enrichedVideos).toBe(119);
  });

  it("keeps a boundary video one day either side of the window so it can be classified", async () => {
    const { client, videoCalls } = fakeClient({
      pages: [
        {
          items: [
            item(1, "2026-10-06T20:00:00Z"),
            item(2, "2026-10-07T05:00:00Z"),
            item(3, "2024-09-02T10:00:00Z"),
            item(4, "2024-09-01T00:00:00Z"),
          ],
          nextPageToken: null,
        },
      ],
      videos: {},
    });
    await discoverCreator({ client, entry, window: WINDOW, now: NOW });
    expect(videoCalls).toEqual([[vid(1), vid(3)]]);
  });

  it("fetches a video with no listed date, because it cannot be ruled out", async () => {
    const { client, videoCalls } = fakeClient({ pages: [{ items: [item(1, null)], nextPageToken: null }], videos: {} });
    await discoverCreator({ client, entry, window: WINDOW, now: NOW });
    expect(videoCalls).toEqual([[vid(1)]]);
  });

  it("stops listing once the uploads are older than the window", async () => {
    const { client, pageRequests } = fakeClient({
      pages: [
        { items: [item(1, "2025-10-09T15:00:00Z")], nextPageToken: "T1" },
        { items: [item(2, "2024-01-01T00:00:00Z")], nextPageToken: "T2" },
        { items: [item(3, "2023-01-01T00:00:00Z")], nextPageToken: null },
      ],
      videos: { [vid(1)]: apiVideo(vid(1)) },
    });
    const result = await discoverCreator({ client, entry, window: WINDOW, now: NOW });
    expect(pageRequests).toEqual([null, "T1"]);
    expect(result).toMatchObject({ uploadPages: 2, stoppedEarly: true });
  });

  it("applies owner decisions, refuses unconfirmed creators and videos from another channel", async () => {
    const pages = [{ items: [item(2, "2025-10-09T15:00:00Z")], nextPageToken: null }];
    const flagged = apiVideo(vid(2), { title: "NFL Week 6 best bets" });
    const decided = await discoverCreator({
      client: fakeClient({ pages, videos: { [vid(2)]: flagged } }).client,
      entry,
      window: WINDOW,
      decisions: [{ videoId: vid(2), decision: "include", reason: "props throughout" }],
      now: NOW,
    });
    expect(decided.manifest.videos[0]).toMatchObject({ status: "present", classification: { status: "needs-review" } });

    await expect(
      discoverCreator({ client: fakeClient({ pages }).client, entry: { ...entry, confirmed: false }, window: WINDOW, now: NOW })
    ).rejects.toMatchObject({ code: "creator-not-confirmed" });
    await expect(
      discoverCreator({
        client: fakeClient({ pages, videos: { [vid(2)]: apiVideo(vid(2), { channelId: channel("z") }) } }).client,
        entry,
        window: WINDOW,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "video-from-other-channel" });
  });
});

describe("screenManifests", () => {
  it("summarises weekly coverage per creator and season, and renders a table", async () => {
    const entry: RegistryEntry = {
      key: "a",
      name: "n",
      seedVideoId: vid(1),
      channelId: channel("a"),
      channelTitle: "t",
      uploadsPlaylistId: "UU" + "a".repeat(22),
      titleMatch: "exact",
      confirmed: true,
      apiFetchedAt: NOW.toISOString(),
    };
    const { client } = fakeClient({
      pages: [{ items: [vid(1), vid(2), vid(3)].map((videoId, n) => ({ videoId, publishedAt: ["2025-10-09T15:00:00Z", "2025-10-16T15:00:00Z", "2024-09-05T15:00:00Z"][n] })), nextPageToken: null }],
      videos: {
        [vid(1)]: apiVideo(vid(1)),
        [vid(2)]: apiVideo(vid(2), { title: "NFL Week 7 best bets", publishedAt: "2025-10-16T15:00:00Z" }),
        [vid(3)]: apiVideo(vid(3), { title: "NFL Week 1 Player Props", publishedAt: "2024-09-05T15:00:00Z" }),
      },
    });
    const { manifest } = await discoverCreator({ client, entry, window: WINDOW, now: NOW });
    const [row] = screenManifests([manifest]);
    expect(row).toMatchObject({ key: "a", weeks: 18 + 18 + 4, present: 2, needsReview: 1, missing: 37 });
    expect(row.bySeason.map((season) => season.season)).toEqual([2024, 2025, 2026]);
    expect(row.presentShare).toBeCloseTo(2 / 40, 3);
    const report = formatScreenReport([row]);
    expect(report.split("\n")[0]).toMatch(/^creator\s+weeks\s+present\s+review\s+missing\s+share/);
    expect(report).toContain("a  ");
  });
});

describe("rebuildDiscovery", () => {
  const event = (overrides: Partial<DecisionEvent> = {}): DecisionEvent => ({
    videoId: supportVid(1),
    decision: "include",
    reason: "props throughout",
    ruleVersion: "v1",
    decidedAt: "2026-10-07T13:00:00.000Z",
    ...overrides,
  });
  const rebuild = (decisions: Record<string, DecisionEvent[]>, discovery = discoveryFor([record(1), record(2, { title: "NFL Week 6 recap" })])) =>
    rebuildDiscovery({ discovery, decisions, now: NOW });

  it("applies the active decision and carries its provenance into the manifest", () => {
    const result = rebuild({ "creator-a": [event()] });
    const video = result.creators[0].manifest.videos.find((entry) => entry.videoId === supportVid(1))!;
    expect(video).toMatchObject({
      status: "present",
      classification: { status: "needs-review" },
      decision: { decision: "include", ruleVersion: "v1", decidedAt: "2026-10-07T13:00:00.000Z" },
    });
    expect(result.rebuiltAt).toBe(NOW.toISOString());
    expect(result.creators[1].manifest.videos).toHaveLength(1);
  });

  it("treats a cleared decision as no override", () => {
    const result = rebuild({
      "creator-a": [event(), event({ decision: "clear", reason: "unsure", decidedAt: "2026-10-07T14:00:00.000Z" })],
    });
    const video = result.creators[0].manifest.videos.find((entry) => entry.videoId === supportVid(1))!;
    expect(video).toMatchObject({ status: "needs-review", decision: null });
  });

  it("does not modify its input and works without any API access", () => {
    const discovery = discoveryFor([record(1)]);
    const before = JSON.stringify(discovery);
    rebuildDiscovery({ discovery, decisions: { "creator-a": [event()] }, now: NOW });
    expect(JSON.stringify(discovery)).toBe(before);
  });

  it("keeps a decision about a video that is no longer available, reports it, and does not apply it", () => {
    const discovery = discoveryFor([record(1)]);
    discovery.creators[0].unavailableVideoIds = [supportVid(77)];
    const result = rebuildDiscovery({
      discovery,
      decisions: { "creator-a": [event(), event({ videoId: supportVid(77), reason: "was a good one" })] },
      now: NOW,
    });
    expect(result.decisionsNotApplied).toEqual([{ creatorKey: "creator-a", videoId: supportVid(77), why: "video-unavailable" }]);
    expect(result.creators[0].manifest.videos.map((video) => video.videoId)).toEqual([supportVid(1)]);
    expect(result.creators[0].manifest.videos[0].decision).toMatchObject({ decision: "include" });
    // A decision for a video that is neither present nor listed as unavailable is still an error.
    expect(() =>
      rebuildDiscovery({ discovery, decisions: { "creator-a": [event({ videoId: supportVid(78) })] }, now: NOW })
    ).toThrow(expect.objectContaining({ code: "invalid-decisions-present" }));
  });

  it("reports an empty list when every decision was applied", () => {
    expect(rebuild({ "creator-a": [event()] }).decisionsNotApplied).toEqual([]);
  });

  it("refuses stale API data with a fixed code", () => {
    const stale = discoveryFor([record(1, { apiFetchedAt: "2026-08-01T00:00:00.000Z" })]);
    expect(() => rebuild({}, stale)).toThrow(expect.objectContaining({ code: "stale-discovery-data" }));
  });

  it("refuses decisions for creators it does not know and decisions that would silently not count", () => {
    expect(() => rebuild({ "creator-z": [event()] })).toThrow(expect.objectContaining({ code: "unknown-creator-in-decisions" }));
    expect(() => rebuild({ "creator-a": [event({ videoId: supportVid(77) })] })).toThrow(
      expect.objectContaining({ code: "invalid-decisions-present" })
    );
    const outside = discoveryFor([record(1), record(2, { publishedAt: "2025-02-01T12:00:00Z" })]);
    expect(() => rebuild({ "creator-a": [event({ videoId: supportVid(2) })] }, outside)).toThrow(
      expect.objectContaining({ code: "invalid-decisions-present" })
    );
  });
});
