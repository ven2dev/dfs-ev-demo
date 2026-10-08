// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  YOUTUBE_API_BASE,
  YoutubeApiError,
  createQuotaMeter,
  createYoutubeClient,
  listUploads,
  parseIsoDuration,
  type FetchLike,
  type HttpResponseLike,
  type YoutubeClient,
} from "./youtubeApi.ts";

const KEY = "SECRET-KEY-VALUE-123";
const VIDEO = "abcdefghijk";
const PLAYLIST = "UU" + "a".repeat(22);
const json = (body: unknown, status = 200): HttpResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const videoItem = (overrides: Record<string, unknown> = {}) => ({
  id: VIDEO,
  snippet: {
    title: "Title",
    description: "Description",
    publishedAt: "2025-10-09T15:00:00Z",
    channelId: "UC" + "a".repeat(22),
    channelTitle: "Channel",
    liveBroadcastContent: "none",
  },
  contentDetails: { duration: "PT1H2M3S" },
  ...overrides,
});

type Call = { url: string; init: Parameters<FetchLike>[1] };
const harness = (responses: (HttpResponseLike | Error)[], limit = 100) => {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? json({ items: [] });
  };
  const meter = createQuotaMeter(limit);
  const client = createYoutubeClient({ apiKey: KEY, fetchImpl, meter });
  return { calls, meter, client };
};
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(YoutubeApiError);
    return (error as YoutubeApiError).code;
  }
  throw new Error("expected a rejection");
};

describe("request construction", () => {
  it("calls one fixed host, sends the key only in a header, and refuses redirects", async () => {
    const { calls, client } = harness([json({ items: [videoItem()] })]);
    await client.getVideos([VIDEO]);
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${YOUTUBE_API_BASE}/videos`);
    expect(url.searchParams.get("id")).toBe(VIDEO);
    expect(calls[0].url).not.toContain(KEY);
    expect(url.searchParams.has("key")).toBe(false);
    expect(calls[0].init.headers).toEqual({ "x-goog-api-key": KEY });
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.cache).toBe("no-store");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a blank key before anything else can happen", () => {
    for (const apiKey of ["", "   "]) {
      expect(() => createYoutubeClient({ apiKey, fetchImpl: async () => json({}), meter: createQuotaMeter(1) })).toThrow(
        expect.objectContaining({ code: "api-key-missing" })
      );
    }
  });

  it("refuses identifiers that could change the path or query, without sending or charging", async () => {
    const { calls, client, meter } = harness([]);
    const longList = Array.from({ length: 51 }, () => VIDEO);
    for (const ids of [[], ["../../x"], ["abc/defghi"], ["abcdefghij"], ["abcdefghijkl"], ["abc,defghij"], longList]) {
      expect(await codeOf(client.getVideos(ids))).toBe("invalid-identifier");
    }
    for (const playlist of ["UC" + "a".repeat(22), "UU../../x", "UU" + "a".repeat(21), "../" + PLAYLIST]) {
      expect(await codeOf(client.getUploadsPage(playlist))).toBe("invalid-identifier");
    }
    expect(await codeOf(client.getUploadsPage(PLAYLIST, "bad token&x=1"))).toBe("invalid-identifier");
    expect(calls).toHaveLength(0);
    expect(meter.used).toBe(0);
  });
});

describe("quota accounting", () => {
  it("charges per endpoint before sending and stops at the hard cap without calling the API", async () => {
    const { calls, client, meter } = harness([json({ items: [] }), json({ items: [] })], 2);
    await client.getVideos([VIDEO]);
    await client.getUploadsPage(PLAYLIST);
    expect(meter).toEqual({ limit: 2, used: 2, byEndpoint: { "videos.list": 1, "playlistItems.list": 1 } });
    expect(await codeOf(client.getVideos([VIDEO]))).toBe("quota-limit-reached");
    expect(calls).toHaveLength(2);
    expect(meter.used).toBe(2);
  });

  it("counts a request that fails once it has been sent", async () => {
    const { client, meter } = harness([json({}, 500)]);
    await codeOf(client.getVideos([VIDEO]));
    expect(meter.used).toBe(1);
  });

  it("rejects a non-positive or fractional limit", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) expect(() => createQuotaMeter(limit)).toThrow();
  });
});

describe("failures map to fixed codes that expose nothing", () => {
  const googleError = (reason: string) => ({ error: { errors: [{ reason }] } });
  const cases: [string, HttpResponseLike | Error, string][] = [
    ["400", json({}, 400), "bad-request"],
    ["404", json({}, 404), "not-found"],
    ["500", json({}, 500), "server-error"],
    ["503", json({}, 503), "server-error"],
    ["418", json({}, 418), "http-error"],
    ["403 quotaExceeded", json(googleError("quotaExceeded"), 403), "quota-exceeded"],
    ["403 dailyLimitExceeded", json(googleError("dailyLimitExceeded"), 403), "quota-exceeded"],
    ["403 other reason", json(googleError("forbidden"), 403), "forbidden"],
    ["403 unreadable body", { ok: false, status: 403, json: async () => Promise.reject(new Error("x")) }, "forbidden"],
    ["401", json({}, 401), "forbidden"],
    ["network failure (e.g. a refused redirect)", new TypeError("fetch failed: https://www.googleapis.com/?key=" + KEY), "network-error"],
    ["timeout", Object.assign(new Error("t"), { name: "TimeoutError" }), "timeout"],
    ["abort", Object.assign(new Error("a"), { name: "AbortError" }), "timeout"],
    ["unparseable success body", { ok: true, status: 200, json: async () => Promise.reject(new Error("x")) }, "invalid-response"],
  ];
  it.each(cases)("%s", async (_name, response, code) => {
    const { client } = harness([response]);
    try {
      await client.getVideos([VIDEO]);
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as YoutubeApiError).code).toBe(code);
      const shown = `${(error as Error).message} ${String(error)} ${JSON.stringify(error)}`;
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain("googleapis");
    }
  });
});

describe("response validation", () => {
  it("parses videos and converts ISO durations", async () => {
    const { client } = harness([json({ items: [videoItem()] })]);
    expect(await client.getVideos([VIDEO])).toEqual([
      {
        videoId: VIDEO,
        title: "Title",
        description: "Description",
        publishedAt: "2025-10-09T15:00:00Z",
        channelId: "UC" + "a".repeat(22),
        channelTitle: "Channel",
        liveBroadcastContent: "none",
        durationSeconds: 3723,
      },
    ]);
  });

  it.each([
    ["items missing", {}],
    ["items not an array", { items: "x" }],
    ["entry without snippet", { items: [{ id: VIDEO, contentDetails: {} }] }],
    ["unknown liveBroadcastContent", { items: [videoItem({ snippet: { ...videoItem().snippet, liveBroadcastContent: "weird" } })] }],
    ["non-string title", { items: [videoItem({ snippet: { ...videoItem().snippet, title: 5 } })] }],
  ])("rejects a malformed videos response: %s", async (_name, body) => {
    const { client } = harness([json(body)]);
    expect(await codeOf(client.getVideos([VIDEO]))).toBe("invalid-response");
  });

  it("keeps an unrecognised duration unknown instead of guessing", async () => {
    const { client } = harness([json({ items: [videoItem({ contentDetails: { duration: "soon" } })] })]);
    expect((await client.getVideos([VIDEO]))[0].durationSeconds).toBeNull();
  });
});

describe("parseIsoDuration", () => {
  it.each([
    ["PT1H2M3S", 3723],
    ["PT45S", 45],
    ["PT10M", 600],
    ["PT2H", 7200],
    ["P1DT1H", 90000],
    ["PT0S", 0],
    ["P0D", 0],
  ])("%s", (value, seconds) => expect(parseIsoDuration(value)).toBe(seconds));
  it.each(["", "P", "PT", "garbage", "1H", "PT-5S", "pt5s"])("treats %j as unknown", (value) =>
    expect(parseIsoDuration(value)).toBeNull()
  );
});

describe("uploads pages", () => {
  it("passes a page token and reads the next token and optional published date", async () => {
    const { calls, client } = harness([
      json({
        items: [
          { contentDetails: { videoId: VIDEO, videoPublishedAt: "2025-01-01T00:00:00Z" } },
          { contentDetails: { videoId: "zzzzzzzzzzz" } },
        ],
        nextPageToken: "TOKEN_1",
      }),
    ]);
    const page = await client.getUploadsPage(PLAYLIST, "PREV_TOKEN");
    expect(new URL(calls[0].url).searchParams.get("pageToken")).toBe("PREV_TOKEN");
    expect(new URL(calls[0].url).searchParams.get("playlistId")).toBe(PLAYLIST);
    expect(page).toEqual({
      items: [
        { videoId: VIDEO, publishedAt: "2025-01-01T00:00:00Z" },
        { videoId: "zzzzzzzzzzz", publishedAt: null },
      ],
      nextPageToken: "TOKEN_1",
    });
  });
});

describe("listUploads", () => {
  const page = (items: [string, string | null][], next: string | null) => ({
    items: items.map(([videoId, publishedAt]) => ({ videoId, publishedAt })),
    nextPageToken: next,
  });
  const fakeClient = (pages: ReturnType<typeof page>[]): YoutubeClient & { requested: (string | null)[] } => {
    const requested: (string | null)[] = [];
    return {
      requested,
      getVideos: async () => [],
      getUploadsPage: async (_playlist, token = null) => {
        requested.push(token);
        return pages[requested.length - 1];
      },
    };
  };
  const notBefore = new Date("2024-09-02T00:00:00Z");

  it("follows page tokens to the end of the playlist", async () => {
    const client = fakeClient([
      page([["a", "2025-02-01T00:00:00Z"]], "T1"),
      page([["b", "2024-12-01T00:00:00Z"]], "T2"),
      page([["c", "2024-10-01T00:00:00Z"]], null),
    ]);
    const result = await listUploads(client, PLAYLIST, { notBefore });
    expect(result).toMatchObject({ pages: 3, stoppedEarly: false });
    expect(result.items.map((item) => item.videoId)).toEqual(["a", "b", "c"]);
    expect(client.requested).toEqual([null, "T1", "T2"]);
  });

  it("stops once a whole page is older than the window start and says so", async () => {
    const client = fakeClient([
      page([["a", "2025-02-01T00:00:00Z"], ["b", "2024-08-01T00:00:00Z"]], "T1"),
      page([["c", "2024-08-15T00:00:00Z"], ["d", "2024-08-01T00:00:00Z"]], "T2"),
      page([["e", "2023-01-01T00:00:00Z"]], null),
    ]);
    const result = await listUploads(client, PLAYLIST, { notBefore });
    expect(result).toMatchObject({ pages: 2, stoppedEarly: true });
    expect(client.requested).toEqual([null, "T1"]);
  });

  it("never stops early on an item without a published date", async () => {
    const client = fakeClient([
      page([["a", "2024-01-01T00:00:00Z"], ["b", null]], "T1"),
      page([["c", "2024-01-01T00:00:00Z"]], null),
    ]);
    expect(await listUploads(client, PLAYLIST, { notBefore })).toMatchObject({ pages: 2 });
  });

  it("fails rather than looping forever on an endless playlist", async () => {
    const endless = Array.from({ length: 5 }, () => page([["a", "2025-01-01T00:00:00Z"]], "NEXT"));
    expect(await codeOf(listUploads(fakeClient(endless), PLAYLIST, { notBefore, maxPages: 3 }))).toBe(
      "page-limit-reached"
    );
  });
});
