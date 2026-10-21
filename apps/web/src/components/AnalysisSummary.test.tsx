import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WatchedProp, WatchSelection } from "@/types";
import { AnalysisSummary } from "./AnalysisSummary";

const selection: WatchSelection = {
  eventId: "fixture", sportKey: "americanfootball_nfl", marketKey: "player_pass_yds",
  homeTeam: "Home", awayTeam: "Away", startTime: "2026-10-20T17:00:00Z",
  playerName: "Example Player", propType: "Passing Yards", direction: "over", bookmakerKey: "draftkings",
};
const snapshot: WatchedProp = {
  propId: "fixture-prop", dataSource: "fixture", line: 245.5, sampleSize: 4, sampleWindow: 5,
  updatedAt: Date.parse("2026-10-20T12:00:00Z"),
  evScore: { modelProb: 0.565, impliedProb: 0.5, edge: 0.065 },
  stages: { baseRate: 0.6, afterEnvironment: 0.6, afterCoverage: 0.565 },
  marketConsensus: { method: "exact-line-median", version: 1, contributingBookCount: 3 },
  evHistory: [],
};
const show = (value: WatchedProp | undefined = snapshot) => render(
  <AnalysisSummary snapshot={value} selection={selection} requestedWindow={5} connectionStatus="live" />,
);

describe("AnalysisSummary presentation", () => {
  it("leads the three sections with the available edge and its estimate/market basis", () => {
    show();
    const summary = screen.getByLabelText("Result summary");
    expect(summary).toHaveTextContent("Illustrative edge +6.5 pts (Over 245.5 at draftkings): estimate 56.5% vs market 50.0%.");
    expect(summary.querySelector("strong")).toHaveTextContent("+6.5 pts");
    for (const section of screen.getAllByRole("region")) {
      expect(summary.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it.each([
    { ...snapshot, marketConsensus: undefined },
    { ...snapshot, stages: undefined },
    { ...snapshot, evScore: { ...snapshot.evScore!, edge: NaN } },
  ])("leads with an unavailable edge without any number when its inputs are invalid", value => {
    show(value);
    const summary = screen.getByLabelText("Result summary");
    expect(summary).toHaveTextContent("Illustrative edge unavailable.");
    expect(summary.textContent).not.toMatch(/\d/);
    expect(screen.getByRole("region", { name: "Edge" })).toHaveTextContent("Edge unavailable");
    expect(summary.compareDocumentPosition(screen.getByRole("region", { name: "Estimate" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("separates estimate, watched offer, market consensus and edge with honest units", () => {
    show();
    expect(screen.getAllByRole("heading").map(h => h.textContent)).toEqual(["Estimate", "Market", "Edge"]);
    const estimate = screen.getByRole("region", { name: "Estimate" });
    expect(within(estimate).getByText("Recent hit rate · n = 4 games")).toBeInTheDocument();
    expect(within(estimate).getByText("56.5%")).toBeInTheDocument();
    expect(estimate).toHaveTextContent("includes sample coverage data");
    const market = screen.getByRole("region", { name: "Market" });
    expect(market).toHaveTextContent("draftkings · over 245.5");
    expect(market).toHaveTextContent("50.0% · 3 books");
    expect(market).toHaveTextContent("Price unavailable");
    expect(screen.getByRole("region", { name: "Edge" })).toHaveTextContent("+6.5 pts");
    expect(screen.getByText(/Not a return per stake/)).toBeInTheDocument();
    expect(screen.getByText(/Estimates are not guarantees/)).toBeInTheDocument();
    expect(screen.queryByText(/fair price/i)).not.toBeInTheDocument();
  });

  it.each([0, -0.00001])("shows a zero rounded edge without treating it as missing: %s", edge => {
    show({ ...snapshot, evScore: { ...snapshot.evScore!, edge } });
    expect(within(screen.getByRole("region", { name: "Edge" })).getByText("0.0 pts")).toBeInTheDocument();
  });

  it("shows a negative edge in points", () => {
    show({ ...snapshot, evScore: { ...snapshot.evScore!, edge: -0.042 } });
    expect(within(screen.getByRole("region", { name: "Edge" })).getByText("-4.2 pts")).toBeInTheDocument();
  });

  it("does not score a missing same-line consensus", () => {
    show({ ...snapshot, marketConsensus: undefined });
    expect(screen.getByRole("region", { name: "Market" })).toHaveTextContent("Market consensus unavailable");
    expect(screen.getByRole("region", { name: "Edge" })).toHaveTextContent("Edge unavailable");
    expect(screen.queryByText("+6.5 pts")).not.toBeInTheDocument();
  });

  it("renders explicit unavailable states before the first result", () => {
    render(<AnalysisSummary selection={selection} requestedWindow={5} connectionStatus="connecting" />);
    expect(screen.getByRole("region", { name: "Estimate" })).toHaveTextContent("Estimate unavailable");
    expect(screen.getByRole("region", { name: "Market" })).toHaveTextContent("line unavailable");
    expect(screen.getByRole("region", { name: "Edge" })).toHaveTextContent("Edge unavailable");
  });

  it("rejects non-finite numeric input without displaying NaN", () => {
    show({ ...snapshot, line: NaN, evScore: { modelProb: NaN, impliedProb: 0.5, edge: NaN } });
    expect(screen.getByRole("region", { name: "Estimate" })).toHaveTextContent("Estimate unavailable");
    expect(screen.getByRole("region", { name: "Market" })).toHaveTextContent("line unavailable");
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it("retains the result, sample labels and as-of time when refresh fails", () => {
    render(<AnalysisSummary snapshot={{ ...snapshot, refreshState: "failed" }} selection={selection} requestedWindow={3} connectionStatus="disconnected" />);
    expect(screen.getByText("Stale · update failed")).toBeInTheDocument();
    expect(screen.getByText(/Showing the last valid result/)).toHaveTextContent("Last 5 window; requested last 3 games");
    expect(screen.getByRole("region", { name: "Estimate" })).toHaveTextContent("56.5%");
    expect(screen.getByRole("region", { name: "Edge" })).toHaveTextContent("+6.5 pts");
    expect(screen.getByRole("region", { name: "Market" })).toHaveTextContent("synthetic fixture line");
  });

  it("labels a retained earlier quote with its own line, source and observation time", () => {
    show({ ...snapshot, line: 249.5, quote: { bookmakerKey: "draftkings", price: 1.8,
      line: 245.5, timestamp: snapshot.updatedAt! - 90_000, dataSource: "fixture" } });
    const market = screen.getByRole("region", { name: "Market" });
    expect(market).toHaveTextContent("draftkings · over 249.5");
    expect(market).toHaveTextContent("Earlier quote · Sample data · Decimal price 1.80 at line 245.5");
    expect(within(market).queryByText("Price unavailable.")).not.toBeInTheDocument();
    expect(market.querySelector("time")).toHaveAttribute("datetime", new Date(snapshot.updatedAt! - 90_000).toISOString());
  });
});
