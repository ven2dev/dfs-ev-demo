import { describe, it, expect } from "vitest";
import { useAppStore } from "../index";

const initialState = useAppStore.getState();

const resetStore = () => useAppStore.setState(initialState, true);

describe("matchupSlice: real slate state", () => {
  it("setRealSlate/setRealSlateStatus/setRealSlateError set independently", () => {
    resetStore();

    useAppStore.getState().setRealSlate([
      {
        id: "evt-1",
        sportKey: "americanfootball_nfl",
        homeTeam: "Chicago Bears",
        awayTeam: "Seattle Seahawks",
        commenceTime: "2026-10-05T17:00:00Z",
      },
    ]);
    useAppStore.getState().setRealSlateStatus("loaded");

    const state = useAppStore.getState();
    expect(state.realSlate).toHaveLength(1);
    expect(state.realSlateStatus).toBe("loaded");
    expect(state.realSlateError).toBe(null);
  });
});

describe("matchupSlice: selectedEventId", () => {
  it("selecting an event resets any discovery state left over from a PREVIOUS event", () => {
    resetStore();
    useAppStore.setState({
      checkedMarketKeys: ["player_pass_yds"],
      discoveredProps: [{ playerName: "Jalen Hurts", markets: [] }],
      discoveryStatus: "loaded",
      discoveryError: "some stale error",
    });

    useAppStore.getState().setSelectedEventId("evt-2");

    const state = useAppStore.getState();
    expect(state.selectedEventId).toBe("evt-2");
    expect(state.checkedMarketKeys).toEqual([]);
    expect(state.discoveredProps).toEqual([]);
    expect(state.discoveryStatus).toBe("idle");
    expect(state.discoveryError).toBe(null);
  });

  it("deselecting (null) also clears discovery state, not just switching to another event", () => {
    resetStore();
    useAppStore.setState({
      selectedEventId: "evt-1",
      checkedMarketKeys: ["player_rush_yds"],
      discoveredProps: [{ playerName: "Saquon Barkley", markets: [] }],
    });

    useAppStore.getState().setSelectedEventId(null);

    const state = useAppStore.getState();
    expect(state.selectedEventId).toBe(null);
    expect(state.checkedMarketKeys).toEqual([]);
    expect(state.discoveredProps).toEqual([]);
  });
});

describe("matchupSlice: toggleMarketKey", () => {
  it("adds a market key that isn't currently checked", () => {
    resetStore();

    useAppStore.getState().toggleMarketKey("player_pass_yds");

    expect(useAppStore.getState().checkedMarketKeys).toEqual(["player_pass_yds"]);
  });

  it("removes a market key that's already checked, rather than adding a duplicate", () => {
    resetStore();
    useAppStore.setState({ checkedMarketKeys: ["player_pass_yds", "player_rush_yds"] });

    useAppStore.getState().toggleMarketKey("player_pass_yds");

    expect(useAppStore.getState().checkedMarketKeys).toEqual(["player_rush_yds"]);
  });

  it("leaves other checked markets untouched when toggling one off", () => {
    resetStore();
    useAppStore.setState({
      checkedMarketKeys: ["player_pass_yds", "player_rush_yds", "player_receptions"],
    });

    useAppStore.getState().toggleMarketKey("player_rush_yds");

    expect(useAppStore.getState().checkedMarketKeys).toEqual([
      "player_pass_yds",
      "player_receptions",
    ]);
  });
});

describe("matchupSlice: discovered props state", () => {
  it("setDiscoveredProps/setDiscoveryStatus/setDiscoveryError set independently", () => {
    resetStore();

    useAppStore.getState().setDiscoveredProps([{ playerName: "Jalen Hurts", markets: [] }]);
    useAppStore.getState().setDiscoveryStatus("error");
    useAppStore.getState().setDiscoveryError("Odds API events fetch failed: 500");

    const state = useAppStore.getState();
    expect(state.discoveredProps).toHaveLength(1);
    expect(state.discoveryStatus).toBe("error");
    expect(state.discoveryError).toBe("Odds API events fetch failed: 500");
  });
});

describe("matchupSlice: primaryWatch/secondaryWatch", () => {
  const sampleSelection = {
    eventId: "evt-1",
    sportKey: "americanfootball_nfl",
    homeTeam: "Chicago Bears",
    awayTeam: "Philadelphia Eagles",
    startTime: "2026-10-05T17:00:00Z",
    marketKey: "player_pass_yds",
    propType: "Passing Yards",
    playerName: "Jalen Hurts",
    bookmakerKey: "draftkings",
  };

  it("setPrimaryWatch and setSecondaryWatch are independent of each other", () => {
    resetStore();

    useAppStore.getState().setPrimaryWatch(sampleSelection);

    expect(useAppStore.getState().primaryWatch).toEqual(sampleSelection);
    expect(useAppStore.getState().secondaryWatch).toBe(null);

    const secondSelection = { ...sampleSelection, playerName: "Saquon Barkley" };
    useAppStore.getState().setSecondaryWatch(secondSelection);

    expect(useAppStore.getState().primaryWatch).toEqual(sampleSelection); // untouched
    expect(useAppStore.getState().secondaryWatch).toEqual(secondSelection);
  });

  it("either selection can be cleared back to null independently", () => {
    resetStore();
    useAppStore.setState({ primaryWatch: sampleSelection, secondaryWatch: sampleSelection });

    useAppStore.getState().setPrimaryWatch(null);

    expect(useAppStore.getState().primaryWatch).toBe(null);
    expect(useAppStore.getState().secondaryWatch).toEqual(sampleSelection);
  });
});
