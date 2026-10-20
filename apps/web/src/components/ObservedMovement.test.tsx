import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EVHistoryEntry, WatchedProp } from "@/types";
import { ObservedMovement } from "./ObservedMovement";

const context: NonNullable<EVHistoryEntry["context"]> = { propId: "prop", bookmakerKey: "draftkings", direction: "over",
  sampleWindow: 5, dataSource: "fixture", line: 247.5, price: 1.8, marketProbability: 0.52 };
const first: EVHistoryEntry = { timestamp: Date.parse("2026-10-20T19:30:00Z"), evScore: -0.042, context };
const last: EVHistoryEntry = { timestamp: first.timestamp + 90_000, evScore: -0.03,
  context: { ...context, line: 249.5, price: 2, marketProbability: 0.5 } };
const show = (history: EVHistoryEntry[], session = "session") => {
  const snapshot: WatchedProp = { propId: "prop", evHistory: history, historySessionId: session, dataSource: "fixture" };
  return render(<ObservedMovement snapshot={snapshot} sessionId="session" />);
};

describe("ObservedMovement", () => {
  it("compares the session baseline with the current quote and gives an honest since time", () => {
    show([first, last]);
    expect(screen.getByText(/Line 247.5 → 249.5 at draftkings/)).toBeInTheDocument();
    expect(screen.getByText(/Decimal price 1.80 → 2.00/)).toHaveTextContent("52.0% → 50.0%");
    expect(screen.getByText(/Observed illustrative edge/)).toHaveTextContent("-4.2 pts → -3.0 pts (+1.2 pts change)");
    expect(document.querySelector("time")).toHaveAttribute("datetime", new Date(first.timestamp).toISOString());
    expect(screen.getByText(/history resets on reload/)).toHaveTextContent("Fixture/sample observations");
  });

  it.each([{ points: [] }, { points: [first] }])("waits for two observations: %j", ({ points }) => {
    show(points);
    expect(screen.getByText(/Collecting another observation/)).toBeInTheDocument();
    expect(screen.queryByText(/Line 247.5 →/)).not.toBeInTheDocument();
  });

  it("does not present a hydrated previous session as observed on this page", () => {
    show([first, last], "previous-session");
    expect(screen.getByText(/Collecting another observation/)).toBeInTheDocument();
  });

  it.each([
    undefined,
    { ...context, bookmakerKey: "fanduel" },
    { ...context, sampleWindow: 3 as const },
    { ...context, dataSource: "live" as const },
    { ...context, propId: "another-prop" },
    { ...context, direction: "under" as const },
    { ...context, price: undefined },
  ])("uses edge-only wording for missing or differing quote context: %j", changed => {
    show([first, { ...last, context: changed }]);
    expect(screen.getByText(/Quote context unavailable or changed/)).toBeInTheDocument();
    expect(screen.getByText(/Observed illustrative edge/)).toBeInTheDocument();
    expect(screen.queryByText(/Line 247.5/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Decimal price/)).not.toBeInTheDocument();
  });

  it("handles legacy entries without backfilling current quote information", () => {
    show([{ timestamp: first.timestamp, evScore: 0.01 }, last]);
    expect(screen.getByText(/Observed illustrative edge/)).toHaveTextContent("+1.0 pts → -3.0 pts");
    expect(screen.queryByText(/Line 247.5/)).not.toBeInTheDocument();
  });

  it("shows no change for equal or equal-rounded edges and lines", () => {
    show([first, { ...first, timestamp: last.timestamp, evScore: first.evScore - 0.00001 }]);
    expect(screen.getByText(/Line unchanged at 247.5/)).toBeInTheDocument();
    expect(screen.getByText(/Observed illustrative edge/)).toHaveTextContent("(no change)");
  });

  it("ignores invalid entries and orders valid timestamps without mutating history", () => {
    const history = [last, { timestamp: NaN, evScore: 0 }, { timestamp: first.timestamp + 1, evScore: NaN }, first];
    show(history);
    expect(screen.getByText(/Observed illustrative edge/)).toHaveTextContent("-4.2 pts → -3.0 pts");
    expect(history[0]).toBe(last);
  });
});
