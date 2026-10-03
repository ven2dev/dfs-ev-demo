import type {
  EventOddsResponse,
  OddsBookmaker,
  OddsMarket,
  SlateEvent,
} from "./oddsApi";
import { getCurrentNflSlateWindow } from "./nflWeek";
import type { PlayerPropMarketKey } from "./playerPropMarkets";

export const FIXTURE_SPORT_KEY = "americanfootball_nfl";

type FixturePlayer = {
  name: string;
  position: "QB" | "RB" | "WR";
};

const players = [
  { name: "Avery Stone", position: "QB" },
  { name: "Jordan Vale", position: "QB" },
  { name: "Casey Rowan", position: "RB" },
  { name: "Morgan Reed", position: "WR" },
] as const satisfies readonly FixturePlayer[];

const marketFixtures: Record<
  PlayerPropMarketKey,
  { playerIndexes: readonly number[]; point?: number; yesPrice?: number }
> = {
  player_pass_yds: { playerIndexes: [0, 1], point: 244.5 },
  player_pass_tds: { playerIndexes: [0, 1], point: 1.5 },
  player_pass_completions: { playerIndexes: [0, 1], point: 21.5 },
  player_pass_attempts: { playerIndexes: [0, 1], point: 33.5 },
  player_pass_interceptions: { playerIndexes: [0, 1], point: 0.5 },
  player_rush_yds: { playerIndexes: [0, 1, 2], point: 54.5 },
  player_rush_attempts: { playerIndexes: [0, 1, 2], point: 13.5 },
  player_reception_yds: { playerIndexes: [2, 3], point: 67.5 },
  player_receptions: { playerIndexes: [2, 3], point: 5.5 },
  player_anytime_td: { playerIndexes: [0, 1, 2, 3], yesPrice: 2.2 },
  player_1st_td: { playerIndexes: [0, 1, 2, 3], yesPrice: 8.5 },
  player_last_td: { playerIndexes: [0, 1, 2, 3], yesPrice: 8.8 },
};

const bookmakerAdjustments = [
  { key: "fixture-northstar", priceDelta: 0 },
  { key: "fixture-harbor", priceDelta: 0.02 },
  { key: "fixture-summit", priceDelta: -0.01 },
] as const;

const fixtureEventId = (week: number) => `fixture-week-${week}-harbor-at-summit`;

const fixtureKickoff = (now: Date) => {
  const window = getCurrentNflSlateWindow(now);
  const start = Date.parse(window.startTime);
  // Saturday at 4 PM Eastern is derived from the active league week, so
  // fixture deployments never age out because of a hard-coded season date.
  return new Date(start + (4 * 24 + 16) * 60 * 60 * 1000).toISOString();
};

export const getFixtureSlateEvents = (
  sportKey: string,
  now: Date = new Date()
): SlateEvent[] => {
  if (sportKey !== FIXTURE_SPORT_KEY) return [];
  const window = getCurrentNflSlateWindow(now);
  return [
    {
      id: fixtureEventId(window.week),
      sportKey,
      homeTeam: "Summit City Sentinels",
      awayTeam: "Harbor Point Captains",
      commenceTime: fixtureKickoff(now),
    },
  ];
};

const buildMarket = (
  marketKey: PlayerPropMarketKey,
  priceDelta: number
): OddsMarket => {
  const fixture = marketFixtures[marketKey];
  const selectedPlayers = fixture.playerIndexes.map((index) => players[index]);

  if (fixture.yesPrice !== undefined) {
    return {
      key: marketKey,
      outcomes: selectedPlayers.map((player, index) => ({
        name: "Yes",
        description: player.name,
        price: Number((fixture.yesPrice! + priceDelta + index * 0.08).toFixed(2)),
      })),
    };
  }

  return {
    key: marketKey,
    outcomes: selectedPlayers.flatMap((player, index) => {
      const playerPoint = fixture.point! + index * (fixture.point! >= 10 ? 7 : 0);
      return [
        {
          name: "Over",
          description: player.name,
          price: Number((1.9 + priceDelta).toFixed(2)),
          point: playerPoint,
        },
        {
          name: "Under",
          description: player.name,
          price: Number((1.9 - priceDelta).toFixed(2)),
          point: playerPoint,
        },
      ];
    }),
  };
};

export const getFixtureEventOdds = (
  eventId: string,
  marketKeys: PlayerPropMarketKey[],
  now: Date = new Date()
): EventOddsResponse | null => {
  const event = getFixtureSlateEvents(FIXTURE_SPORT_KEY, now).find(
    (candidate) => candidate.id === eventId
  );
  if (!event) return null;

  const bookmakers: OddsBookmaker[] = bookmakerAdjustments.map(({ key, priceDelta }) => ({
    key,
    title: key,
    markets: marketKeys.map((marketKey) => buildMarket(marketKey, priceDelta)),
  }));

  return {
    id: event.id,
    sport_key: event.sportKey,
    commence_time: event.commenceTime,
    home_team: event.homeTeam,
    away_team: event.awayTeam,
    bookmakers,
  };
};

export const FIXTURE_PLAYERS = players;
