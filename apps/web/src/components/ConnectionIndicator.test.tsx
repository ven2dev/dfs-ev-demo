import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useAppStore } from "@/store";
import { ConnectionIndicator } from "./ConnectionIndicator";

const initialState = useAppStore.getState();
const selection = {
  eventId: "fixture-game", sportKey: "americanfootball_nfl", marketKey: "player_pass_yds",
  homeTeam: "Home", awayTeam: "Away", startTime: "2026-10-18T17:00:00Z",
  playerName: "Sample Player", propType: "Passing Yards", bookmakerKey: "sample", direction: "over" as const,
};
afterEach(() => useAppStore.setState(initialState, true));

it("keeps connection changes visible while account data is loading or failed", () => {
  useAppStore.setState({ dataVerified: false, primaryWatch: selection, connectionStatus: "connecting" });
  render(<ConnectionIndicator />);
  expect(screen.getByRole("status", { name: "Odds connection" })).toHaveTextContent("connecting");
  act(() => useAppStore.setState({ dataLoadError: "Unable to load account", connectionStatus: "disconnected" }));
  expect(screen.getByRole("status", { name: "Odds connection" })).toHaveTextContent("disconnected");
  act(() => useAppStore.setState({ connectionStatus: "stale" }));
  expect(screen.getByRole("status", { name: "Odds connection" })).toHaveTextContent("stale");
});

it("distinguishes idle tracking from an interrupted watched-prop stream", () => {
  useAppStore.setState({ primaryWatch: null, connectionStatus: "disconnected" });
  render(<ConnectionIndicator />);
  const indicator = screen.getByRole("status", { name: "Odds connection" });
  expect(indicator).toHaveTextContent("Not tracking");
  act(() => useAppStore.setState({ primaryWatch: selection }));
  expect(indicator).toHaveTextContent("disconnected");
  act(() => useAppStore.setState({ primaryWatch: null }));
  expect(indicator).toHaveTextContent("Not tracking");
});
