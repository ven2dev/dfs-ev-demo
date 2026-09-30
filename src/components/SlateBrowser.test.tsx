import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { SlateBrowser } from "./SlateBrowser";

const initialState = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialState, true);
  vi.restoreAllMocks();
});

const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>;

const mockFetchOnce = (data: unknown) => {
  fetchMock().mockResolvedValueOnce({ json: () => Promise.resolve(data) });
};

const sampleEvents = [
  {
    id: "evt-2",
    sportKey: "americanfootball_nfl",
    homeTeam: "Chicago Bears",
    awayTeam: "Green Bay Packers",
    commenceTime: "2026-10-11T17:00:00Z",
  },
  {
    id: "evt-1",
    sportKey: "americanfootball_nfl",
    homeTeam: "Cleveland Browns",
    awayTeam: "Pittsburgh Steelers",
    commenceTime: "2026-10-02T00:15:00Z",
  },
];

describe("SlateBrowser", () => {
  it("loads the real slate on mount and lists games sorted by kickoff time, not arrival order", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, events: sampleEvents });

    render(<SlateBrowser />);

    const select = await screen.findByLabelText("Select a game");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options[1]).toContain("Pittsburgh Steelers @ Cleveland Browns");
    expect(options[2]).toContain("Green Bay Packers @ Chicago Bears");
  });

  it("shows an error message if the real slate fails to load", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: false, reason: "Internal error" });

    render(<SlateBrowser />);

    expect(await screen.findByText("Internal error")).toBeInTheDocument();
  });

  it("shows the market checklist after selecting a game, and checking boxes alone fetches nothing", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, events: sampleEvents });

    render(<SlateBrowser />);
    const select = await screen.findByLabelText("Select a game");
    fireEvent.change(select, { target: { value: "evt-1" } });

    expect(await screen.findByText("Which prop markets?")).toBeInTheDocument();
    // Multiple toggles, not just one -- a stale-closure bug that only
    // fires on the SECOND toggle onward would still pass a single-click
    // check, so this needs at least two to be a real assertion.
    fireEvent.click(screen.getByLabelText("Passing Yards"));
    fireEvent.click(screen.getByLabelText("Rushing Yards"));
    fireEvent.click(screen.getByLabelText("Receptions"));

    expect(fetchMock()).toHaveBeenCalledTimes(1); // only the initial /api/slate call
  });

  it("fetches discovered props only when 'Show props' is clicked, batching every checked market into one request", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, events: sampleEvents });

    render(<SlateBrowser />);
    fireEvent.change(await screen.findByLabelText("Select a game"), {
      target: { value: "evt-1" },
    });
    fireEvent.click(await screen.findByLabelText("Passing Yards"));
    fireEvent.click(screen.getByLabelText("Rushing Yards"));

    mockFetchOnce({
      success: true,
      eventId: "evt-1",
      players: [
        {
          playerName: "Jalen Hurts",
          markets: [
            {
              marketKey: "player_pass_yds",
              lines: [{ bookmakerKey: "draftkings", side: "over", price: 1.91, point: 214.5 }],
            },
          ],
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Show props" }));

    expect(await screen.findByText("Jalen Hurts")).toBeInTheDocument();
    const requestedUrl = fetchMock().mock.calls[1][0] as string;
    expect(requestedUrl).toContain(
      "/api/slate/evt-1/props?markets=player_pass_yds%2Cplayer_rush_yds"
    );
    expect(requestedUrl).not.toContain("refresh=true");
  });

  it("shows a Refresh odds button only after props have been shown, and it requests with refresh=true", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, events: sampleEvents });

    render(<SlateBrowser />);
    fireEvent.change(await screen.findByLabelText("Select a game"), {
      target: { value: "evt-1" },
    });
    fireEvent.click(await screen.findByLabelText("Passing Yards"));

    expect(screen.queryByRole("button", { name: "Refresh odds" })).not.toBeInTheDocument();

    mockFetchOnce({
      success: true,
      eventId: "evt-1",
      players: [{ playerName: "Jalen Hurts", markets: [] }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Show props" }));
    await screen.findByText("Jalen Hurts");

    mockFetchOnce({ success: true, eventId: "evt-1", players: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh odds" }));

    await waitFor(() => {
      const lastCall = fetchMock().mock.calls.at(-1)?.[0] as string;
      expect(lastCall).toContain("refresh=true");
    });
  });
});
