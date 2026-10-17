import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WatchedProp } from "@/types";
import { ResultFreshness } from "./ResultFreshness";

const snapshot: WatchedProp = {
  propId: "example", sampleWindow: 5, sampleSize: 4, updatedAt: Date.parse("2026-10-16T21:14:00Z"),
  evScore: { modelProb: 0.6, impliedProb: 0.5, edge: 0.1 },
  evHistory: [], stages: { baseRate: 0.6, afterEnvironment: 0.6, afterCoverage: 0.6 },
};

describe("ResultFreshness", () => {
  it("pairs an amber updating badge with the old window and last successful time", () => {
    const { container } = render(<ResultFreshness snapshot={{ ...snapshot, refreshState: "updating" }} requestedWindow={3} connectionStatus="live" />);
    expect(screen.getByText("Stale · updating to last 3 games")).toHaveClass("bg-amber-50");
    expect(screen.getByRole("status")).toHaveTextContent("Showing the last valid result · Last 5 window; requested last 3 games");
    expect(container.querySelector("time")).toHaveAttribute("datetime", "2026-10-16T21:14:00.000Z");
  });

  it("uses red and explicit failure text while retaining the original result description", () => {
    render(<ResultFreshness snapshot={{ ...snapshot, refreshState: "failed" }} requestedWindow={3} connectionStatus="disconnected" />);
    expect(screen.getByText("Stale · update failed")).toHaveClass("bg-red-50");
    expect(screen.getByRole("status")).toHaveTextContent("Last 5 window");
  });

  it("marks paused updates amber", () => {
    render(<ResultFreshness snapshot={{ ...snapshot, refreshState: "paused" }} requestedWindow={5} connectionStatus="stale" />);
    expect(screen.getByText("Stale · updates paused")).toHaveClass("bg-amber-50");
  });

  it("removes the stale badge after a fresh replacement arrives", () => {
    const { rerender } = render(<ResultFreshness snapshot={{ ...snapshot, refreshState: "updating" }} requestedWindow={3} connectionStatus="connecting" />);
    rerender(<ResultFreshness snapshot={{ ...snapshot, sampleWindow: 3 }} requestedWindow={3} connectionStatus="live" />);
    expect(screen.queryByText(/Stale/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Showing the latest result · Last 3 window");
  });

  it("does not invent a timestamp or old window for legacy data", () => {
    render(<ResultFreshness snapshot={{ ...snapshot, sampleWindow: undefined, updatedAt: undefined }} requestedWindow={7} connectionStatus="connecting" />);
    expect(screen.getByText(/Original window unavailable/)).toHaveTextContent("Update time unavailable");
  });

  it("does not label an optimistic zero placeholder as a retained result", () => {
    render(<ResultFreshness snapshot={{ propId: "empty", evHistory: [], evScore: { modelProb: 0, impliedProb: 0, edge: 0 } }} requestedWindow={5} connectionStatus="connecting" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
