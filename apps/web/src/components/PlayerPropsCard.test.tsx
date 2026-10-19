import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PlayerPropsCard } from "./PlayerPropsCard";
import type { DiscoveredPlayer } from "@/lib/discoveredProps";

const player: DiscoveredPlayer = {
  playerName: "Avery Stone",
  markets: [
    {
      marketKey: "player_pass_yds",
      lines: [
        { bookmakerKey: "draftkings", side: "over", price: 2.0, point: 224.5 },
        { bookmakerKey: "draftkings", side: "under", price: 1.8, point: 224.5 },
        { bookmakerKey: "fanduel", side: "over", price: 1.9, point: 224.5 },
        { bookmakerKey: "fanduel", side: "under", price: 2.1, point: 224.5 },
        { bookmakerKey: "outlier", side: "over", price: 3, point: 220.5 },
        { bookmakerKey: "outlier", side: "under", price: 3, point: 220.5 },
      ],
    },
    {
      marketKey: "player_anytime_td",
      lines: [{ bookmakerKey: "draftkings", side: "yes", price: 3.2 }],
    },
  ],
};

const defaults = {
  player,
  mode: "single" as const,
  smartDefault: true,
  selectedBookmakerKey: null,
  comparisonBookmakerKeys: [],
  onSeeAll: vi.fn(),
  onWatch: vi.fn(),
};

describe("PlayerPropsCard", () => {
  it("selects best books independently for each side at the modal line, with full accessible action names", () => {
    const onWatch = vi.fn();
    render(<PlayerPropsCard {...defaults} onWatch={onWatch} />);
    const over = screen.getByRole("button", { name: "Watch Over 224.5 Passing Yards at draftkings for Avery Stone" });
    const under = screen.getByRole("button", { name: "Watch Under 224.5 Passing Yards at fanduel for Avery Stone" });
    expect(over).toBeEnabled();
    expect(under).toBeEnabled();
    expect(screen.queryByText("220.5")).not.toBeInTheDocument();
    fireEvent.click(over);
    fireEvent.click(under);
    expect(onWatch.mock.calls).toEqual([
      [{ marketKey: "player_pass_yds", bookmakerKey: "draftkings", direction: "over" }],
      [{ marketKey: "player_pass_yds", bookmakerKey: "fanduel", direction: "under" }],
    ]);
  });

  it("shows the chosen sportsbook's own line and both prices instead of the smart defaults", () => {
    const onWatch = vi.fn();
    render(<PlayerPropsCard {...defaults} smartDefault={false} selectedBookmakerKey="outlier" onWatch={onWatch} />);
    const market = screen.getByRole("region", { name: "Passing Yards for Avery Stone" });
    expect(within(market).getByText("Over 220.5")).toBeInTheDocument();
    expect(within(market).getByText("Under 220.5")).toBeInTheDocument();
    expect(within(market).getAllByText("Price 3")).toHaveLength(2);
    fireEvent.click(within(market).getByRole("button", { name: /Watch Under 220.5.*outlier/ }));
    expect(onWatch).toHaveBeenCalledWith({ marketKey: "player_pass_yds", bookmakerKey: "outlier", direction: "under" });
  });

  it("ignores the manual book while Best available is active", () => {
    render(<PlayerPropsCard {...defaults} selectedBookmakerKey="missing" />);
    expect(screen.getByRole("button", { name: /Watch Over 224.5.*draftkings/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Watch Under 224.5.*fanduel/ })).toBeEnabled();
  });

  it("explains missing manual coverage and prevents either action", () => {
    const onWatch = vi.fn();
    render(<PlayerPropsCard {...defaults} smartDefault={false} selectedBookmakerKey="missing" onWatch={onWatch} />);
    for (const button of screen.getAllByRole("button", { name: /^Watch/ })) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("This sportsbook does not cover this market.");
      fireEvent.click(button);
    }
    expect(onWatch).not.toHaveBeenCalled();
    expect(screen.getAllByText("This sportsbook does not cover this market.")).toHaveLength(2);
  });

  it("shows the existing single-side quote but explains why analysis needs both prices", () => {
    const incomplete: DiscoveredPlayer = { playerName: player.playerName, markets: [{ marketKey: "player_pass_yds", lines: [player.markets[0].lines[0]] }] };
    render(<PlayerPropsCard {...defaults} player={incomplete} smartDefault={false} selectedBookmakerKey="draftkings" />);
    expect(screen.getByText("Price 2")).toBeInTheDocument();
    expect(screen.getByText("Price —")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: /^Watch/ })) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("Both Over and Under prices are required for analysis.");
    }
  });

  it("never presents prices from different lines as a watchable two-way quote", () => {
    const mismatched = structuredClone(player);
    mismatched.markets = [mismatched.markets[0]];
    mismatched.markets[0].lines[1].point = 230.5;
    render(<PlayerPropsCard {...defaults} player={mismatched} smartDefault={false} selectedBookmakerKey="draftkings" />);
    expect(screen.getByText("Over 230.5")).toBeInTheDocument();
    expect(screen.getByText("Under 230.5")).toBeInTheDocument();
    expect(screen.getByText("Price —")).toBeInTheDocument();
    expect(screen.getByText("Price 1.8")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: /^Watch/ })) expect(button).toBeDisabled();
  });

  it("honestly reports that Best available has no complete quote instead of choosing an incomplete book", () => {
    const incomplete: DiscoveredPlayer = { playerName: player.playerName, markets: [{ marketKey: "player_pass_yds", lines: [player.markets[0].lines[0]] }] };
    render(<PlayerPropsCard {...defaults} player={incomplete} />);
    for (const button of screen.getAllByRole("button", { name: /^Watch/ })) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("No complete two-way quote is available at the shared market line.");
    }
  });

  it("keeps yes-only markets browse-only and gives See all books a contextual name", () => {
    const onSeeAll = vi.fn();
    render(<PlayerPropsCard {...defaults} onSeeAll={onSeeAll} />);
    const market = screen.getByRole("region", { name: "Anytime Touchdown for Avery Stone" });
    expect(within(market).getByText("Yes · Price 3.2 · draftkings")).toBeInTheDocument();
    expect(within(market).getByText(/Browse only/)).toBeInTheDocument();
    expect(within(market).queryByRole("button", { name: /^Watch/ })).not.toBeInTheDocument();
    fireEvent.click(within(market).getByRole("button", { name: "See all books for Avery Stone Anytime Touchdown" }));
    expect(onSeeAll).toHaveBeenCalledWith("player_anytime_td");
    expect(screen.getByRole("button", { name: "See all books for Avery Stone Passing Yards" })).toBeInTheDocument();
  });

  it("normal mode has no table, scroll hint, focusable scroll wrapper or sticky column", () => {
    const { container } = render(<PlayerPropsCard {...defaults} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/Scroll the table sideways/)).not.toBeInTheDocument();
    expect(container.querySelector('[tabindex="0"]')).toBeNull();
    expect(container.querySelector('.sticky')).toBeNull();
  });

  it("compare mode preserves labeled keyboard scrolling, sticky column, each book's quotes, and contextual See all actions", () => {
    const onSeeAll = vi.fn();
    const { container } = render(<PlayerPropsCard {...defaults} mode="compare" comparisonBookmakerKeys={["draftkings", "fanduel"]} onSeeAll={onSeeAll} />);
    const region = screen.getByRole("region", { name: "Avery Stone prop prices" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveAccessibleDescription(/Scroll the table sideways/);
    expect(screen.getByRole("columnheader", { name: "draftkings" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "fanduel" })).toBeInTheDocument();
    expect(screen.getByText("224.5 · 2 / 1.8")).toBeInTheDocument();
    expect(screen.getByText("224.5 · 1.9 / 2.1")).toBeInTheDocument();
    expect(container.querySelector('.sticky')).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Watch/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "See all books for Avery Stone Passing Yards" }));
    expect(onSeeAll).toHaveBeenCalledWith("player_pass_yds");
  });
});
