// Minimal official YouTube Data API v3 client for the owner-run #88 discovery
// tools. It only ever calls two read endpoints on one fixed host, sends the
// key in a header (never a URL), refuses redirects, and reports failures as
// fixed codes that cannot contain the key, a URL or a raw response.
export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

export type ApiErrorCode =
  | "api-key-missing"
  | "invalid-identifier"
  | "quota-limit-reached"
  | "quota-exceeded"
  | "bad-request"
  | "forbidden"
  | "not-found"
  | "server-error"
  | "http-error"
  | "network-error"
  | "timeout"
  | "invalid-response"
  | "page-limit-reached";

export class YoutubeApiError extends Error {
  code: ApiErrorCode;
  constructor(code: ApiErrorCode) {
    super(code);
    this.code = code;
  }
}

const fail = (code: ApiErrorCode): never => {
  throw new YoutubeApiError(code);
};

// Documented quota cost of each call used here; both are 1 unit per request.
export const QUOTA_COST = { "videos.list": 1, "playlistItems.list": 1 } as const;
export type QuotaEndpoint = keyof typeof QUOTA_COST;
const ENDPOINT_PATH: Record<QuotaEndpoint, string> = {
  "videos.list": "videos",
  "playlistItems.list": "playlistItems",
};

export type QuotaMeter = {
  limit: number;
  used: number;
  byEndpoint: Record<QuotaEndpoint, number>;
};

export const createQuotaMeter = (limit: number): QuotaMeter => {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Quota limit must be a positive integer");
  return { limit, used: 0, byEndpoint: { "videos.list": 0, "playlistItems.list": 0 } };
};

// Charged before the request is sent, so a run can never exceed its hard cap.
const charge = (meter: QuotaMeter, endpoint: QuotaEndpoint): void => {
  const cost = QUOTA_COST[endpoint];
  if (meter.used + cost > meter.limit) fail("quota-limit-reached");
  meter.used += cost;
  meter.byEndpoint[endpoint] += cost;
};

export type HttpResponseLike = { ok: boolean; status: number; json: () => Promise<unknown> };
export type FetchLike = (
  url: string,
  init: {
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: "error";
    cache: "no-store";
  }
) => Promise<HttpResponseLike>;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const UPLOADS_PLAYLIST_ID = /^UU[A-Za-z0-9_-]{22}$/;
const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,200}$/;
export const isVideoId = (value: string): boolean => VIDEO_ID.test(value);
export const isUploadsPlaylistId = (value: string): boolean => UPLOADS_PLAYLIST_ID.test(value);
export const MAX_VIDEOS_PER_REQUEST = 50;

export type ApiVideo = {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  channelId: string;
  channelTitle: string;
  liveBroadcastContent: "none" | "upcoming" | "live";
  durationSeconds: number | null;
};

export type UploadItem = { videoId: string; publishedAt: string | null };
export type UploadsPage = { items: UploadItem[]; nextPageToken: string | null };

export type YoutubeClient = {
  getVideos: (videoIds: readonly string[]) => Promise<ApiVideo[]>;
  getUploadsPage: (playlistId: string, pageToken?: string | null) => Promise<UploadsPage>;
};

// ISO 8601 durations as returned by the API (PT1H2M3S). "P0D" is what live
// and upcoming broadcasts report; anything unrecognised stays unknown (null).
export const parseIsoDuration = (value: string): number | null => {
  if (value === "P0D") return 0;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match || match.slice(1).every((part) => part === undefined)) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : fail("invalid-response"));

const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"]);

const failureForStatus = async (response: HttpResponseLike): Promise<never> => {
  if (response.status === 401 || response.status === 403) {
    let reason: unknown;
    try {
      const body = await response.json();
      const errors = isRecord(body) && isRecord(body.error) ? body.error.errors : undefined;
      reason = Array.isArray(errors) && isRecord(errors[0]) ? errors[0].reason : undefined;
    } catch {
      reason = undefined;
    }
    return fail(typeof reason === "string" && QUOTA_REASONS.has(reason) ? "quota-exceeded" : "forbidden");
  }
  if (response.status === 400) return fail("bad-request");
  if (response.status === 404) return fail("not-found");
  if (response.status >= 500) return fail("server-error");
  return fail("http-error");
};

export const createYoutubeClient = ({
  apiKey,
  fetchImpl,
  meter,
  timeoutMs = 15_000,
}: {
  apiKey: string;
  fetchImpl: FetchLike;
  meter: QuotaMeter;
  timeoutMs?: number;
}): YoutubeClient => {
  if (!apiKey.trim()) fail("api-key-missing");

  const request = async (endpoint: QuotaEndpoint, params: Record<string, string>): Promise<unknown> => {
    charge(meter, endpoint);
    const url = new URL(`${YOUTUBE_API_BASE}/${ENDPOINT_PATH[endpoint]}`);
    url.search = new URLSearchParams(params).toString();
    let response: HttpResponseLike;
    try {
      response = await fetchImpl(url.toString(), {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        cache: "no-store",
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return fail(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network-error");
    }
    if (!response.ok) return failureForStatus(response);
    try {
      return await response.json();
    } catch {
      return fail("invalid-response");
    }
  };

  const items = (body: unknown): unknown[] =>
    isRecord(body) && Array.isArray(body.items) ? body.items : fail("invalid-response");

  const getVideos: YoutubeClient["getVideos"] = async (videoIds) => {
    if (videoIds.length < 1 || videoIds.length > MAX_VIDEOS_PER_REQUEST || !videoIds.every(isVideoId)) {
      return fail("invalid-identifier");
    }
    const body = await request("videos.list", {
      part: "snippet,contentDetails",
      id: videoIds.join(","),
      maxResults: String(MAX_VIDEOS_PER_REQUEST),
    });
    return items(body).map((entry): ApiVideo => {
      if (!isRecord(entry) || !isRecord(entry.snippet) || !isRecord(entry.contentDetails)) {
        return fail("invalid-response");
      }
      const live = entry.snippet.liveBroadcastContent;
      if (live !== "none" && live !== "upcoming" && live !== "live") return fail("invalid-response");
      return {
        videoId: text(entry.id),
        title: text(entry.snippet.title),
        description: text(entry.snippet.description),
        publishedAt: text(entry.snippet.publishedAt),
        channelId: text(entry.snippet.channelId),
        channelTitle: text(entry.snippet.channelTitle),
        liveBroadcastContent: live,
        durationSeconds: parseIsoDuration(text(entry.contentDetails.duration)),
      };
    });
  };

  const getUploadsPage: YoutubeClient["getUploadsPage"] = async (playlistId, pageToken = null) => {
    if (!isUploadsPlaylistId(playlistId) || (pageToken !== null && !PAGE_TOKEN.test(pageToken))) {
      return fail("invalid-identifier");
    }
    const params: Record<string, string> = {
      part: "contentDetails",
      playlistId,
      maxResults: String(MAX_VIDEOS_PER_REQUEST),
    };
    if (pageToken) params.pageToken = pageToken;
    const body = await request("playlistItems.list", params);
    const next = isRecord(body) ? body.nextPageToken : undefined;
    return {
      items: items(body).map((entry): UploadItem => {
        if (!isRecord(entry) || !isRecord(entry.contentDetails)) return fail("invalid-response");
        const published = entry.contentDetails.videoPublishedAt;
        return {
          videoId: text(entry.contentDetails.videoId),
          publishedAt: typeof published === "string" ? published : null,
        };
      }),
      nextPageToken: typeof next === "string" ? next : null,
    };
  };

  return { getVideos, getUploadsPage };
};

// The uploads playlist lists newest first, so listing can stop once a whole
// page is older than the window start. Items without a published date are
// never treated as old, so an unusual entry cannot end the listing early.
export const listUploads = async (
  client: YoutubeClient,
  playlistId: string,
  { notBefore, maxPages = 200 }: { notBefore: Date; maxPages?: number }
): Promise<{ items: UploadItem[]; pages: number; stoppedEarly: boolean }> => {
  const collected: UploadItem[] = [];
  let pageToken: string | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const result: UploadsPage = await client.getUploadsPage(playlistId, pageToken);
    collected.push(...result.items);
    const allOld =
      result.items.length > 0 &&
      result.items.every(
        (item) => item.publishedAt !== null && Date.parse(item.publishedAt) < notBefore.getTime()
      );
    if (allOld) return { items: collected, pages: page, stoppedEarly: result.nextPageToken !== null };
    if (!result.nextPageToken) return { items: collected, pages: page, stoppedEarly: false };
    pageToken = result.nextPageToken;
  }
  return fail("page-limit-reached");
};
