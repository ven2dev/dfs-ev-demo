import {
  NFL_REGULAR_SEASON_WEEKS,
  getNflRegularSeasonWeek,
  getRegisteredNflSeasons,
} from "./nflSeasonCalendar.ts";

// Inclusion rule v1 for the #88 creator-corpus manifest. A video is an
// expected weekly NFL player-prop video when it was published in a registered
// NFL regular-season week and its title marks it as player-prop picks.
// Anything less clear is flagged for the owner, never silently decided. The
// rule is pure and versioned: a different keyword set is a new version.
export const INCLUSION_RULE_VERSION = "v1";
export const SHORT_FORM_MAX_SECONDS = 120;

// Signals are matched against lower-cased text with punctuation removed, on
// whole words or phrases. Title signals are strong; description-only signals
// are only ever grounds for review, because descriptions carry channel
// boilerplate that lists every sport and topic the channel covers.
export const RULE_V1_TERMS = {
  // Owner-approved clear prop signals: props, player props, DFS and player TDs.
  prop: ["prop", "props", "dfs", "player td", "player tds"],
  // Review-only: pick'em platforms and generic pick words are not enough alone.
  picks: [
    "picks",
    "best bets",
    "predictions",
    "parlay",
    "parlays",
    "locks",
    "plays",
    "prizepicks",
    "pickem",
    "pick em",
  ],
  // Fantasy-football content is out of scope unless the title also says props.
  fantasy: ["fantasy"],
  strongProp: ["prop", "props"],
  nfl: [
    "nfl",
    "tnf",
    "snf",
    "mnf",
    "thursday night football",
    "sunday night football",
    "monday night football",
  ],
  // Nicknames are ambiguous with other leagues (Giants, Cardinals, Jets,
  // Panthers), so a team name alone is only ever grounds for review.
  team: [
    "cardinals", "falcons", "ravens", "bills", "panthers", "bears", "bengals", "browns",
    "cowboys", "broncos", "lions", "packers", "texans", "colts", "jaguars", "chiefs",
    "raiders", "chargers", "rams", "dolphins", "vikings", "patriots", "saints", "giants",
    "jets", "eagles", "steelers", "49ers", "seahawks", "buccaneers", "titans", "commanders",
  ],
  otherLeague: [
    "nba", "wnba", "mlb", "nhl", "ncaab", "ncaaf", "cfb", "college football",
    "college basketball", "ufc", "mma", "soccer", "epl", "premier league", "golf", "nascar",
  ],
} as const;

export type VideoRecord = {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSeconds: number | null;
  liveBroadcastContent: "none" | "upcoming" | "live";
  // When the owner-run tool fetched this API data; see the staleness helper.
  apiFetchedAt: string;
};

// The window always starts at Week 1 of the first registered season. The end
// is chosen and written down at registration, so it cannot drift with "now".
export type RegisteredWindow = { endSeason: number; endWeek: number };

export type ClassificationStatus = "candidate" | "needs-review" | "excluded";

export type ReasonCode =
  | "prop-and-nfl-signal-in-title"
  | "invalid-published-at"
  | "outside-registered-regular-season"
  | "after-registered-end-week"
  | "not-yet-vod"
  | "short-form"
  | "other-league-in-title"
  | "fantasy-in-title"
  | "no-prop-signal"
  | "no-nfl-signal"
  | "duration-unknown"
  | "mixed-league-title"
  | "title-week-mismatch"
  | "multiple-week-references"
  | "nfl-signal-team-name-only"
  | "nfl-signal-description-only"
  | "picks-without-prop-signal"
  | "prop-signal-description-only";

export type VideoClassification = {
  status: ClassificationStatus;
  reasons: ReasonCode[];
  season: number | null;
  week: number | null;
  ruleVersion: typeof INCLUSION_RULE_VERSION;
};

export const assertValidWindow = (window: RegisteredWindow): void => {
  if (
    !getRegisteredNflSeasons().includes(window.endSeason) ||
    !Number.isInteger(window.endWeek) ||
    window.endWeek < 1 ||
    window.endWeek > NFL_REGULAR_SEASON_WEEKS
  ) {
    throw new Error("Registered window end must be a registered season and a week from 1 to 18");
  }
};

export const isWeekInWindow = (
  season: number,
  week: number,
  window: RegisteredWindow
): boolean =>
  season < window.endSeason || (season === window.endSeason && week <= window.endWeek);

// Every (season, week) the manifest expects, in order.
export const listWindowWeeks = (
  window: RegisteredWindow
): { season: number; week: number }[] => {
  assertValidWindow(window);
  const weeks: { season: number; week: number }[] = [];
  for (const season of getRegisteredNflSeasons()) {
    for (let week = 1; week <= NFL_REGULAR_SEASON_WEEKS; week++) {
      if (isWeekInWindow(season, week, window)) weeks.push({ season, week });
    }
  }
  return weeks;
};

const normalize = (text: string): string =>
  ` ${text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

const hasAny = (text: string, terms: readonly string[]): boolean =>
  terms.some((term) => text.includes(` ${term} `));

const weekReferences = (text: string): number[] => [
  ...new Set(
    [...text.matchAll(/ (?:week|wk) (\d{1,2})(?= )/g)].map((match) => Number(match[1]))
  ),
];

const classification = (
  status: ClassificationStatus,
  reasons: ReasonCode[],
  season: number | null,
  week: number | null
): VideoClassification => ({
  status,
  reasons,
  season,
  week,
  ruleVersion: INCLUSION_RULE_VERSION,
});

export const classifyVideo = (
  video: VideoRecord,
  window: RegisteredWindow
): VideoClassification => {
  assertValidWindow(window);

  const published = new Date(video.publishedAt);
  if (Number.isNaN(published.getTime())) {
    return classification("excluded", ["invalid-published-at"], null, null);
  }
  const placed = getNflRegularSeasonWeek(published);
  if (!placed) {
    return classification("excluded", ["outside-registered-regular-season"], null, null);
  }
  const { season, week } = placed;
  if (!isWeekInWindow(season, week, window)) {
    return classification("excluded", ["after-registered-end-week"], season, week);
  }
  if (video.liveBroadcastContent !== "none") {
    return classification("excluded", ["not-yet-vod"], season, week);
  }
  if (video.durationSeconds !== null && video.durationSeconds < SHORT_FORM_MAX_SECONDS) {
    return classification("excluded", ["short-form"], season, week);
  }

  const title = normalize(video.title);
  const description = normalize(video.description);
  const nflInTitle = hasAny(title, RULE_V1_TERMS.nfl);
  const titleWeeks = weekReferences(title);
  const footballInTitle = nflInTitle || titleWeeks.length > 0;
  const propInTitle = hasAny(title, RULE_V1_TERMS.prop);
  const otherLeagueInTitle = hasAny(title, RULE_V1_TERMS.otherLeague);

  if (otherLeagueInTitle && !nflInTitle) {
    return classification("excluded", ["other-league-in-title"], season, week);
  }
  // "Props" in the title keeps a video in scope even when a sponsor line says
  // "Fantasy"; DFS alone does not, so DFS-plus-fantasy titles are excluded.
  if (hasAny(title, RULE_V1_TERMS.fantasy) && !hasAny(title, RULE_V1_TERMS.strongProp)) {
    return classification("excluded", ["fantasy-in-title"], season, week);
  }

  const reasons: ReasonCode[] = [];
  let status: ClassificationStatus;
  if (otherLeagueInTitle) {
    status = "needs-review";
    reasons.push("mixed-league-title");
  } else if (propInTitle && footballInTitle) {
    status = "candidate";
    reasons.push("prop-and-nfl-signal-in-title");
  } else if (propInTitle && hasAny(title, RULE_V1_TERMS.team)) {
    status = "needs-review";
    reasons.push("nfl-signal-team-name-only");
  } else if (propInTitle && hasAny(description, RULE_V1_TERMS.nfl)) {
    status = "needs-review";
    reasons.push("nfl-signal-description-only");
  } else if (!propInTitle && footballInTitle && hasAny(title, RULE_V1_TERMS.picks)) {
    status = "needs-review";
    reasons.push("picks-without-prop-signal");
  } else if (!propInTitle && footballInTitle && hasAny(description, RULE_V1_TERMS.prop)) {
    status = "needs-review";
    reasons.push("prop-signal-description-only");
  } else {
    return classification(
      "excluded",
      [propInTitle ? "no-nfl-signal" : "no-prop-signal"],
      season,
      week
    );
  }

  // A stated week that disagrees with the publish date is exactly the kind of
  // case that must not be decided automatically.
  if (titleWeeks.length > 1) {
    status = "needs-review";
    reasons.push("multiple-week-references");
  } else if (titleWeeks.length === 1 && titleWeeks[0] !== week) {
    status = "needs-review";
    reasons.push("title-week-mismatch");
  }
  if (video.durationSeconds === null) {
    status = "needs-review";
    reasons.push("duration-unknown");
  }
  return classification(status, reasons, season, week);
};
