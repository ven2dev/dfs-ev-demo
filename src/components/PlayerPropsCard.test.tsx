import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlayerPropsCard } from "./PlayerPropsCard";
import type { DiscoveredPlayer } from "@/lib/discoveredProps";

const player: DiscoveredPlayer = {
  playerName: "Jalen Hurts",
  markets: [
    {
      marketKey: "player_pass_yds",
      lines: [
        { bookmakerKey: "draftkings", side: "over", price: 1.91, point: 214.5 },
        { bookmakerKey: "draftkings", side: "under", price: 1.89, point: 214.5 },
        { bookmakerKey: "fanduel", side: "over", price: 1.87, point: 213.5 },
        { bookmakerKey: "fanduel", side: "under", price: 1.95, point: 213.5 },
      ],
    },
    {
      marketKey: "player_anytime_td",
      lines: [
        { bookmakerKey: "draftkings", side: "yes", price: 3.2 },
        { bookmakerKey: "fanduel", side: "yes", price: 3.1 },
      ],
    },
  ],
};

describe("PlayerPropsCard", () => {
  it("single mode shows only the selected bookmaker's line and prices", () => {
    render(
      <PlayerPropsCard
        player={player}
        mode="single"
        selectedBookmakerKey="fanduel"
        comparisonBookmakerKeys={[]}
        onSeeAll={vi.fn()}
      />
    );

    expect(screen.getByText("213.5")).toBeInTheDocument();
    expect(screen.getByText("1.87 / 1.95")).toBeInTheDocument();
    expect(screen.queryByText("214.5")).not.toBeInTheDocument();
    expect(screen.queryByText("1.91 / 1.89")).not.toBeInTheDocument();
  });

  it("single mode shows just the price, not a line, for a single-sided ('yes') market", () => {
    render(
      <PlayerPropsCard
        player={player}
        mode="single"
        selectedBookmakerKey="draftkings"
        comparisonBookmakerKeys={[]}
        onSeeAll={vi.fn()}
      />
    );

    const rows = screen.getAllByRole("row");
    const tdRow = rows.find((row) => row.textContent?.includes("Anytime Touchdown"));
    expect(tdRow?.textContent).toContain("3.2");
    expect(tdRow?.textContent).not.toContain("undefined");
  });

  it("shows '—' rather than throwing when the selected bookmaker doesn't cover a prop", () => {
    render(
      <PlayerPropsCard
        player={player}
        mode="single"
        selectedBookmakerKey="betmgm"
        comparisonBookmakerKeys={[]}
        onSeeAll={vi.fn()}
      />
    );

    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("compare mode shows a column per selected bookmaker, each with its own line/prices", () => {
    render(
      <PlayerPropsCard
        player={player}
        mode="compare"
        selectedBookmakerKey={null}
        comparisonBookmakerKeys={["draftkings", "fanduel"]}
        onSeeAll={vi.fn()}
      />
    );

    expect(screen.getByText("draftkings")).toBeInTheDocument();
    expect(screen.getByText("fanduel")).toBeInTheDocument();
    expect(screen.getByText("214.5 · 1.91 / 1.89")).toBeInTheDocument();
    expect(screen.getByText("213.5 · 1.87 / 1.95")).toBeInTheDocument();
  });

  it("calls onSeeAll with the market key when 'See all' is clicked", () => {
    const onSeeAll = vi.fn();
    render(
      <PlayerPropsCard
        player={player}
        mode="single"
        selectedBookmakerKey="draftkings"
        comparisonBookmakerKeys={[]}
        onSeeAll={onSeeAll}
      />
    );

    fireEvent.click(screen.getAllByText("See all")[0]);

    expect(onSeeAll).toHaveBeenCalledWith("player_pass_yds");
  });
});
