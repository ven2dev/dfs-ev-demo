import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { INCLUSION_RULE_VERSION, assertValidWindow, type RegisteredWindow } from "../../src/lib/creatorVideoRule.ts";
import { getNflRegularSeasonWeekWindow } from "../../src/lib/nflSeasonCalendar.ts";
import { isVideoId } from "./youtubeApi.ts";

export class InputError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new InputError(code);
};

export type CreatorInput = { key: string; name: string; seedVideoId: string };

// Accepts a bare 11-character video ID or a standard watch/short URL. Extra
// URL parts such as &t=323s are ignored. Everything else is refused.
export const parseVideoId = (value: string): string | null => {
  const trimmed = value.trim();
  if (isVideoId(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  let candidate: string | null = null;
  if (host === "youtu.be") candidate = url.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    candidate = url.searchParams.get("v");
  }
  return candidate !== null && isVideoId(candidate) ? candidate : null;
};

const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_CREATORS = 20;

// The owner's private creators file: an array of { key, name, seedVideoId }.
// `key` is an opaque label used in every output; `name` is only compared with
// the channel title at resolve time. `seedVideoId` may be an ID or a URL.
export const parseCreatorsFile = (input: unknown): CreatorInput[] => {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_CREATORS) fail("invalid-creators-file");
  const creators: CreatorInput[] = [];
  for (const entry of input as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail("invalid-creators-file");
    const { key, name, seedVideoId, ...extra } = entry as Record<string, unknown>;
    if (Object.keys(extra).length > 0) return fail("invalid-creators-file");
    if (typeof key !== "string" || !KEY.test(key)) return fail("invalid-creator-key");
    if (typeof name !== "string" || !name.trim() || name.length > 120) return fail("invalid-creator-name");
    const videoId = typeof seedVideoId === "string" ? parseVideoId(seedVideoId) : null;
    if (videoId === null) return fail("invalid-seed-video");
    creators.push({ key, name: name.trim(), seedVideoId: videoId });
  }
  if (new Set(creators.map((creator) => creator.key)).size !== creators.length) fail("duplicate-creator-key");
  return creators;
};

export type Registration = {
  formatVersion: 1;
  ruleVersion: string;
  window: RegisteredWindow;
  registeredAt: string;
};

// The committed registration record: the rule version and window were fixed
// before any data was pulled. A mismatch with the code's rule is refused.
export const parseRegistration = (input: unknown): Registration => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("invalid-registration");
  const value = input as Record<string, unknown>;
  const window = value.window as Record<string, unknown> | null;
  if (
    value.formatVersion !== 1 ||
    value.ruleVersion !== INCLUSION_RULE_VERSION ||
    typeof value.registeredAt !== "string" ||
    Number.isNaN(Date.parse(value.registeredAt)) ||
    typeof window !== "object" ||
    window === null ||
    typeof window.endSeason !== "number" ||
    typeof window.endWeek !== "number" ||
    Object.keys(window).length !== 2 ||
    Object.keys(value).length !== 4
  ) {
    return fail("invalid-registration");
  }
  const registered = { endSeason: window.endSeason, endWeek: window.endWeek };
  try {
    assertValidWindow(registered);
  } catch {
    return fail("invalid-registration");
  }
  return {
    formatVersion: 1,
    ruleVersion: value.ruleVersion,
    window: registered,
    registeredAt: value.registeredAt,
  };
};

export const loadRegistration = async (
  path = fileURLToPath(new URL("./registration.json", import.meta.url))
): Promise<Registration> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fail("invalid-registration");
  }
  return parseRegistration(parsed);
};

export const windowStart = (): Date => {
  const first = getNflRegularSeasonWeekWindow(2024, 1);
  if (!first) throw new Error("2024 Week 1 is not registered");
  return new Date(first.startTime);
};

// The end of the registered window (exclusive), i.e. when the end week closes.
export const windowEnd = (window: RegisteredWindow): Date => {
  const last = getNflRegularSeasonWeekWindow(window.endSeason, window.endWeek);
  if (!last) throw new Error("Registered end week has no window");
  return new Date(last.endTime);
};

export const isEndWeekClosed = (window: RegisteredWindow, now: Date): boolean =>
  now.getTime() >= windowEnd(window).getTime();
