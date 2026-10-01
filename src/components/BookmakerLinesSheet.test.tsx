import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BookmakerLinesSheet } from "./BookmakerLinesSheet";
import type { DiscoveredPlayer } from "@/lib/discoveredProps";

const players: DiscoveredPlayer[] = [
  {
    playerName: "Jalen Hurts",
    markets: [
      {
        marketKey: "player_pass_yds",
        lines: [
          { bookmakerKey: "draftkings", side: "over", price: 1.91, point: 214.5 },
          { bookmakerKey: "draftkings", side: "under", price: 1.89, point: 214.5 },
          { bookmakerKey: "fanduel", side: "over", price: 1.87, point: 213.5 },
          { bookmakerKey: "fanduel", side: "under", price: 1.95, point: 213.5 },
          { bookmakerKey: "betmgm", side: "over", price: 1.9, point: 214.5 },
          { bookmakerKey: "betmgm", side: "under", price: 1.9, point: 214.5 },
        ],
      },
    ],
  },
];

describe("BookmakerLinesSheet", () => {
  it("renders nothing when there is no target", () => {
    const { container } = render(
      <BookmakerLinesSheet target={null} players={players} onClose={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every bookmaker for the targeted player+market, not just one", () => {
    render(
      <BookmakerLinesSheet
        target={{ playerName: "Jalen Hurts", marketKey: "player_pass_yds" }}
        players={players}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("draftkings")).toBeInTheDocument();
    expect(screen.getByText("fanduel")).toBeInTheDocument();
    expect(screen.getByText("betmgm")).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <BookmakerLinesSheet
        target={{ playerName: "Jalen Hurts", marketKey: "player_pass_yds" }}
        players={players}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicking the backdrop, but not when clicking inside the sheet", () => {
    const onClose = vi.fn();
    render(
      <BookmakerLinesSheet
        target={{ playerName: "Jalen Hurts", marketKey: "player_pass_yds" }}
        players={players}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByText("draftkings"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(
      <BookmakerLinesSheet
        target={{ playerName: "Jalen Hurts", marketKey: "player_pass_yds" }}
        players={players}
        onClose={onClose}
      />
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
