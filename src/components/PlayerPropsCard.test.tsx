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
        smartDefault={false}
        selectedBookmakerKey="fanduel"
        comparisonBookmakerKeys={[]}
        watchDirection="over"
        onSeeAll={vi.fn()}
        onWatch={vi.fn()}
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
        smartDefault={false}
        selectedBookmakerKey="draftkings"
        comparisonBookmakerKeys={[]}
        watchDirection="over"
        onSeeAll={vi.fn()}
        onWatch={vi.fn()}
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
        smartDefault={false}
        selectedBookmakerKey="betmgm"
        comparisonBookmakerKeys={[]}
        watchDirection="over"
        onSeeAll={vi.fn()}
        onWatch={vi.fn()}
      />
    );

    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("compare mode shows a column per selected bookmaker, each with its own line/prices", () => {
    render(
      <PlayerPropsCard
        player={player}
        mode="compare"
        smartDefault={false}
        selectedBookmakerKey={null}
        comparisonBookmakerKeys={["draftkings", "fanduel"]}
        watchDirection="over"
        onSeeAll={vi.fn()}
        onWatch={vi.fn()}
      />
    );

    expect(screen.getByText("draftkings")).toBeInTheDocument();
    expect(screen.getByText("fanduel")).toBeInTheDocument();
    expect(screen.getByText("214.5 · 1.91 / 1.89")).toBeInTheDocument();
    expect(screen.getByText("213.5 · 1.87 / 1.95")).toBeInTheDocument();
  });

  it("smart mode: each prop row independently shows its own best-priced book -- different rows can legitimately show different books", () => {
    const twoMarketPlayer: DiscoveredPlayer = {
      playerName: "Jalen Hurts",
      markets: [
        {
          // fanduel has the highest Over price at this shared line.
          marketKey: "player_pass_yds",
          lines: [
            { bookmakerKey: "draftkings", side: "over", price: 1.91, point: 214.5 },
            { bookmakerKey: "draftkings", side: "under", price: 1.89, point: 214.5 },
            { bookmakerKey: "fanduel", side: "over", price: 2.0, point: 214.5 },
            { bookmakerKey: "fanduel", side: "under", price: 1.83, point: 214.5 },
          ],
        },
        {
          // Reversed -- draftkings has the highest Over price here.
          marketKey: "player_rush_yds",
          lines: [
            { bookmakerKey: "draftkings", side: "over", price: 2.0, point: 71.5 },
            { bookmakerKey: "draftkings", side: "under", price: 1.83, point: 71.5 },
            { bookmakerKey: "fanduel", side: "over", price: 1.91, point: 71.5 },
            { bookmakerKey: "fanduel", side: "under", price: 1.89, point: 71.5 },
          ],
        },
      ],
    };

    render(
      <PlayerPropsCard
        player={twoMarketPlayer}
        mode="single"
        smartDefault
        selectedBookmakerKey={null}
        comparisonBookmakerKeys={[]}
        watchDirection="over"
        onSeeAll={vi.fn()}
        onWatch={vi.fn()}
      />
    );

    const rows = screen.getAllByRole("row");
    const passYdsRow = rows.find((row) => row.textContent?.includes("Passing Yards"));
    const rushYdsRow = rows.find((row) => row.textContent?.includes("Rushing Yards"));

    expect(passYdsRow?.textContent).toContain("fanduel");
    expect(rushYdsRow?.textContent).toContain("draftkings");
  });

  it("smart mode ignores selectedBookmakerKey entirely -- it's the manual-override value, not consulted while smart", () => {
    render(
      <PlayerPropsCard
        player={player}
        mode="single"
        smartDefault
        selectedBookmakerKey="betmgm" // a book that covers nothing for this player
        comparisonBookmakerKeys={[]}
        watchDirection="over"
        onSeeAll={vi.fn()}
        onWatch={vi.fn()}
      />
    );

    // Real cached data exists for fanduel/draftkings -- if betmgm were
    // consulted at all (its own row would legitimately show "--"),
    // these rows would show nothing but dashes instead of real prices.
    const rows = screen.getAllByRole("row");
    const passYdsRow = rows.find((row) => row.textContent?.includes("Passing Yards"));
    const tdRow = rows.find((row) => row.textContent?.includes("Anytime Touchdown"));

    expect(passYdsRow?.textContent).toMatch(/1\.\d\d \/ 1\.\d\d/);
    expect(tdRow?.textContent).toContain("3.2");
  });

  it("calls onSeeAll with the market key when 'See all' is clicked", () => {
    const onSeeAll = vi.fn();
    render(
      <PlayerPropsCard
        player={player}
        mode="single"
        smartDefault={false}
        selectedBookmakerKey="draftkings"
        comparisonBookmakerKeys={[]}
        watchDirection="over"
        onSeeAll={onSeeAll}
        onWatch={vi.fn()}
      />
    );

    fireEvent.click(screen.getAllByText("See all")[0]);

    expect(onSeeAll).toHaveBeenCalledWith("player_pass_yds");
  });

  it("calls onWatch with the market's effective bookmaker when 'Watch' is clicked", () => {
    const onWatch = vi.fn();
    render(
      <PlayerPropsCard
        player={player}
        mode="single"
        smartDefault={false}
        selectedBookmakerKey="draftkings"
        comparisonBookmakerKeys={[]}
        watchDirection="over"
        onSeeAll={vi.fn()}
        onWatch={onWatch}
      />
    );

    fireEvent.click(screen.getAllByText("Watch Over")[0]);

    expect(onWatch).toHaveBeenCalledWith({
      marketKey: "player_pass_yds",
      bookmakerKey: "draftkings",
      direction: "over",
    });
  });

  it("disables Watch when the row has no effective bookmaker to watch", () => {
    render(
      <PlayerPropsCard
        player={player}
        mode="single"
        smartDefault={false}
        selectedBookmakerKey="betmgm" // covers nothing for this player
        comparisonBookmakerKeys={[]}
        watchDirection="over"
        onSeeAll={vi.fn()}
        onWatch={vi.fn()}
      />
    );

    const watchButtons = screen.getAllByText("Watch Over");
    expect(watchButtons.length).toBeGreaterThan(0);
    for (const button of watchButtons) {
      expect(button).toBeDisabled();
    }
  });

  it("does not show a Watch button at all in compare mode", () => {
    render(
      <PlayerPropsCard
        player={player}
        mode="compare"
        smartDefault={false}
        selectedBookmakerKey={null}
        comparisonBookmakerKeys={["draftkings", "fanduel"]}
        watchDirection="over"
        onSeeAll={vi.fn()}
        onWatch={vi.fn()}
      />
    );

    expect(screen.queryByText("Watch Over")).not.toBeInTheDocument();
  });

  it("keeps unsupported yes-only markets browse-only", () => {
    render(
      <PlayerPropsCard
        player={player}
        mode="single"
        smartDefault={false}
        selectedBookmakerKey="draftkings"
        comparisonBookmakerKeys={[]}
        watchDirection="over"
        onSeeAll={vi.fn()}
        onWatch={vi.fn()}
      />
    );

    const rows = screen.getAllByRole("row");
    const tdRow = rows.find((row) => row.textContent?.includes("Anytime Touchdown"));
    expect(tdRow).toHaveTextContent("Browse only");
    expect(tdRow).not.toHaveTextContent("Watch Over");
  });
});
