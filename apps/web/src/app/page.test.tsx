import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { buildWatchPropId } from "@/lib/watchPropId";
import Home from "./page";

vi.mock("@/store/useLiveOddsStream", () => ({ useLiveOddsStream: () => {} }));
vi.mock("@/components/SlateBrowser", () => ({ SlateBrowser: () => null }));

const initialState = useAppStore.getState();
const selection = {
  eventId: "fixture-game", sportKey: "americanfootball_nfl", marketKey: "player_pass_yds",
  homeTeam: "Home Team", awayTeam: "Away Team", startTime: "2026-10-18T17:00:00Z",
  playerName: "Example Player", propType: "Passing Yards", bookmakerKey: "example", direction: "over" as const,
};
const propId = buildWatchPropId(selection);
const snapshot = {
  propId, dataSource: "live" as const, sampleWindow: 5 as const, sampleSize: 4,
  updatedAt: Date.parse("2026-10-16T21:14:00Z"),
  evScore: { modelProb: 0.565, impliedProb: 0.5, edge: 0.065 },
  stages: { baseRate: 0.6, afterEnvironment: 0.6, afterCoverage: 0.565 },
  evHistory: [{ timestamp: 1, evScore: 0.065 }], recentStatAverage: 250, line: 245.5,
};

beforeEach(() => useAppStore.setState({
  dataVerified: true, authStatus: "signed-out", primaryWatch: selection, connectionStatus: "live",
  secondaryWatch: { ...selection, playerName: "Other Player" },
  matchupConfig: { ...initialState.matchupConfig, sampleWindow: 5 },
  goal: { kind: "pickEm", pickCount: 2, picks: [] }, watchlist: { [propId]: snapshot },
}));
afterEach(() => {
  cleanup();
  useAppStore.setState(initialState, true);
});

describe("Home honest interim labels", () => {
  it("removes the pipeline stepper and presents Estimate, Market and Edge", () => {
    render(<Home />);
    expect(screen.queryByRole("list", { name: "Analysis pipeline" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Estimate" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Market" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Edge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 5" })).toHaveAttribute("aria-pressed", "true");
  });

  it("gives a single per-side Watch instruction inside the empty tracker", () => {
    useAppStore.setState({ primaryWatch: null, secondaryWatch: null, watchlist: {} });
    render(<Home />);
    const instruction = screen.getByText(/Select a game and markets above/);
    expect(instruction).toHaveTextContent("Watch Over or Watch Under");
    expect(instruction.parentElement).toContainElement(screen.getByRole("heading", { name: "EV Tracker" }));
    expect(screen.getAllByText(/start tracking/)).toHaveLength(1);
    expect(screen.queryByText("Nothing watched yet.")).not.toBeInTheDocument();
  });

  it("displays actual n and labels every coverage-derived surface as sample data", () => {
    render(<Home />);
    expect(screen.getByText("Recent hit rate · n = 4 games")).toBeInTheDocument();
    expect(within(screen.getByText("Recent hit rate · n = 4 games").parentElement!).getByText("60.0%")).toBeInTheDocument();
    expect(screen.getByText(/Illustrative adjusted estimate/)).toHaveTextContent("includes sample coverage data");
    expect(screen.getByText(/Illustrative edge vs/)).toHaveTextContent("includes sample coverage data");
    expect(screen.getByText(/Example Player — illustrative edge/)).toHaveTextContent("includes sample coverage data");
    expect(screen.getByText(/Adding this pick/)).toHaveTextContent("includes sample coverage data");
    expect(screen.getByText(/Watch changes appear immediately/)).toHaveTextContent("revert if saving fails");
    expect(screen.queryByText(/simulated.*failure rate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/our model/)).not.toBeInTheDocument();
  });

  it("keeps the original count, line, average and estimates visible under a stale window change", () => {
    render(<Home />);
    act(() => useAppStore.setState({
      matchupConfig: { ...useAppStore.getState().matchupConfig, sampleWindow: 3 },
      connectionStatus: "connecting",
      watchlist: { [propId]: { ...snapshot, refreshState: "updating" } },
    }));
    expect(screen.getByText("Recent hit rate · n = 4 games")).toBeInTheDocument();
    expect(screen.getByText(/Average · n = 4 games/)).toHaveTextContent("250.0");
    expect(screen.getAllByText("Stale · updating to last 3 games")).toHaveLength(2);
    expect(screen.getByText(/Example Player — Passing Yards/)).toHaveTextContent("245.5");
    expect(within(screen.getByText("Recent hit rate · n = 4 games").parentElement!).getByText("60.0%")).toBeInTheDocument();
  });

  it("keeps a failed result readable and makes both displayed estimate sections red-labeled", () => {
    useAppStore.setState({ connectionStatus: "disconnected", watchlist: { [propId]: { ...snapshot, refreshState: "failed" } } });
    render(<Home />);
    expect(screen.getAllByText("Stale · update failed")).toHaveLength(2);
    expect(within(screen.getByText("Recent hit rate · n = 4 games").parentElement!).getByText("60.0%")).toBeInTheDocument();
    expect(screen.getByText(/Average · n = 4 games/)).toBeInTheDocument();
  });

  it("retains fixture provenance beside the interim labels", () => {
    useAppStore.setState({ watchlist: { [propId]: { ...snapshot, dataSource: "fixture" } } });
    render(<Home />);
    expect(screen.getByText(/Preview fixture data/)).toBeInTheDocument();
    expect(screen.getByText(/After environment adjustment/)).toHaveTextContent("synthetic fixture weather");
    expect(screen.getByText(/Example Player — Passing Yards/)).toHaveTextContent("synthetic fixture line");
  });
});
