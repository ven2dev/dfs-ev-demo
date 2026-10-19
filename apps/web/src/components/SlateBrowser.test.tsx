import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { SlateBrowser } from "./SlateBrowser";

const initialState = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialState, true);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>;

const sampleWindow = {
  label: "Week 4",
  week: 4,
  phase: "regular-season",
  startTime: "2026-09-29T04:00:00.000Z",
  endTime: "2026-10-06T04:00:00.000Z",
  timeZone: "America/New_York",
};

const mockFetchOnce = (data: unknown) => {
  let response = data;
  if (
    typeof response === "object" &&
    response !== null &&
    "events" in response &&
    !("window" in response)
  ) {
    response = { ...response, window: sampleWindow };
  }
  fetchMock().mockResolvedValueOnce({ json: () => Promise.resolve(response) });
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
  it("titles the section with the server-provided NFL week, not a static label", async () => {
    // shouldAdvanceTime: pins Date.now() while still letting RTL's own
    // internal setTimeout-based polling (findByText, waitFor) actually
    // tick -- plain useFakeTimers() freezes those too and hangs forever.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z")); // verified Week 4 (see nflWeek.test.ts)
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, dataSource: "live", events: [] });

    render(<SlateBrowser />);

    expect(await screen.findByText("Browse the Week 4 slate")).toBeInTheDocument();
  });

  it("labels fixture browsing before the user selects or watches a prop", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, dataSource: "fixture", events: sampleEvents });

    render(<SlateBrowser />);

    expect(await screen.findByText(/Preview fixture data/)).toHaveTextContent(
      "teams, players, books, and prices"
    );
    expect(screen.getByText(/Preview fixture data/)).toHaveTextContent(
      "No live provider calls are made"
    );
  });

  it("loads the slate on mount and lists games sorted by kickoff time, not arrival order", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, dataSource: "live", events: sampleEvents });

    render(<SlateBrowser />);

    const select = await screen.findByLabelText("Select a game");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options[1]).toContain("Pittsburgh Steelers @ Cleveland Browns");
    expect(options[2]).toContain("Green Bay Packers @ Chicago Bears");
  });

  it("refreshes the server-owned slate when the tab regains focus", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, dataSource: "live", events: sampleEvents });

    render(<SlateBrowser />);
    await screen.findByLabelText("Select a game");

    mockFetchOnce({ success: true, dataSource: "live", events: [sampleEvents[0]] });
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
  });

  it("shows an error message if the slate fails to load", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: false, reason: "Internal error" });

    render(<SlateBrowser />);

    expect(await screen.findByText("Internal error")).toBeInTheDocument();
  });

  it("rejects a successful slate response that omits its data source", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, events: sampleEvents });

    render(<SlateBrowser />);

    expect(
      await screen.findByText("Slate response did not identify its data source")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Select a game")).not.toBeInTheDocument();
  });

  it("shows the market checklist after selecting a game, and checking boxes alone fetches nothing", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, dataSource: "live", events: sampleEvents });

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
    mockFetchOnce({ success: true, dataSource: "live", events: sampleEvents });

    render(<SlateBrowser />);
    fireEvent.change(await screen.findByLabelText("Select a game"), {
      target: { value: "evt-1" },
    });
    fireEvent.click(await screen.findByLabelText("Passing Yards"));
    fireEvent.click(screen.getByLabelText("Rushing Yards"));

    mockFetchOnce({
      success: true,
      dataSource: "live",
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

  it("rejects props whose data source differs from the loaded slate", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, dataSource: "live", events: sampleEvents });

    render(<SlateBrowser />);
    fireEvent.change(await screen.findByLabelText("Select a game"), {
      target: { value: "evt-1" },
    });
    fireEvent.click(await screen.findByLabelText("Passing Yards"));

    mockFetchOnce({
      success: true,
      dataSource: "fixture",
      eventId: "evt-1",
      players: [{ playerName: "Wrong Source Player", markets: [] }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Show props" }));

    expect(
      await screen.findByText("Props response did not match the slate data source")
    ).toBeInTheDocument();
    expect(screen.queryByText("Wrong Source Player")).not.toBeInTheDocument();
    expect(useAppStore.getState().discoveredProps).toEqual([]);
  });

  it("ignores a discovery response after the selected event changes", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, dataSource: "live", events: sampleEvents });

    render(<SlateBrowser />);
    const select = await screen.findByLabelText("Select a game");
    fireEvent.change(select, { target: { value: "evt-1" } });
    fireEvent.click(await screen.findByLabelText("Passing Yards"));

    let resolveDiscovery!: (value: { json: () => Promise<unknown> }) => void;
    fetchMock().mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDiscovery = resolve;
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Show props" }));

    fireEvent.change(select, { target: { value: "evt-2" } });
    resolveDiscovery({
      json: () =>
        Promise.resolve({
          success: true,
          dataSource: "live",
          eventId: "evt-1",
          players: [{ playerName: "Stale Player", markets: [] }],
        }),
    });

    await waitFor(() => {
      expect(screen.queryByText("Stale Player")).not.toBeInTheDocument();
      expect(useAppStore.getState().discoveredProps).toEqual([]);
      expect(useAppStore.getState().discoveredPropsEventId).toBeNull();
    });
  });

  const showPropsWithFourBooks = async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, dataSource: "live", events: sampleEvents });

    render(<SlateBrowser />);
    fireEvent.change(await screen.findByLabelText("Select a game"), {
      target: { value: "evt-1" },
    });
    fireEvent.click(await screen.findByLabelText("Passing Yards"));

    mockFetchOnce({
      success: true,
      dataSource: "live",
      eventId: "evt-1",
      players: [
        {
          playerName: "Jalen Hurts",
          markets: [
            {
              marketKey: "player_pass_yds",
              lines: [
                { bookmakerKey: "fanduel", side: "over", price: 1.87, point: 213.5 },
                { bookmakerKey: "fanduel", side: "under", price: 1.95, point: 213.5 },
                { bookmakerKey: "draftkings", side: "over", price: 1.91, point: 214.5 },
                { bookmakerKey: "draftkings", side: "under", price: 1.89, point: 214.5 },
                { bookmakerKey: "betmgm", side: "over", price: 1.9, point: 214.5 },
                { bookmakerKey: "betmgm", side: "under", price: 1.9, point: 214.5 },
                { bookmakerKey: "bovada", side: "over", price: 1.88, point: 214.5 },
                { bookmakerKey: "bovada", side: "under", price: 1.92, point: 214.5 },
              ],
            },
          ],
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Show props" }));
    await screen.findByText("Jalen Hurts");
  };

  it("collapses successful results to a summary and reopens preserved selections without fetching", async () => {
    await showPropsWithFourBooks();

    expect(screen.queryByLabelText("Select a game")).not.toBeInTheDocument();
    expect(screen.queryByText("Which prop markets?")).not.toBeInTheDocument();
    expect(screen.getByText("Pittsburgh Steelers @ Cleveland Browns")).toBeInTheDocument();
    expect(screen.getByText("Passing Yards · 1 player")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh odds" })).toBeEnabled();
    const requests = fetchMock().mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Change selection" }));
    expect(screen.getByLabelText("Select a game")).toHaveValue("evt-1");
    expect(screen.getByLabelText("Passing Yards")).toBeChecked();
    expect(screen.getByText("Jalen Hurts")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(requests);

    fireEvent.click(screen.getByLabelText("Receptions"));
    expect(fetchMock()).toHaveBeenCalledTimes(requests);
    mockFetchOnce({ success: true, dataSource: "live", eventId: "evt-1", players: [] });
    fireEvent.click(screen.getByRole("button", { name: "Show props" }));
    expect(await screen.findByRole("button", { name: "Change selection" })).toBeInTheDocument();
    expect(screen.getByText("Passing Yards, Receptions · 0 players")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(requests + 1);
  });

  it("moves focus to the summary after loading, to the game on reopen, and back without a request", async () => {
    await showPropsWithFourBooks();
    expect(screen.getByRole("button", { name: "Change selection" })).toHaveFocus();
    const requests = fetchMock().mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Change selection" }));
    expect(screen.getByLabelText("Select a game")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep current selection" }));
    expect(screen.getByRole("button", { name: "Change selection" })).toHaveFocus();
    expect(screen.queryByLabelText("Select a game")).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(requests);

    fireEvent.click(screen.getByRole("button", { name: "Change selection" }));
    fireEvent.click(screen.getByLabelText("Receptions"));
    expect(screen.queryByRole("button", { name: "Keep current selection" })).not.toBeInTheDocument();
    mockFetchOnce({ success: true, dataSource: "live", eventId: "evt-1", players: [] });
    fireEvent.click(screen.getByRole("button", { name: "Show props" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Change selection" })).toHaveFocus());
  });

  it("keeps selection open when discovery fails instead of presenting an empty success summary", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, dataSource: "live", events: sampleEvents });
    render(<SlateBrowser />);
    fireEvent.change(await screen.findByLabelText("Select a game"), { target: { value: "evt-1" } });
    fireEvent.click(screen.getByLabelText("Passing Yards"));
    mockFetchOnce({ success: false, reason: "Props unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Show props" }));
    expect(await screen.findByText("Props unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("Select a game")).toHaveValue("evt-1");
    expect(screen.getByLabelText("Passing Yards")).toBeChecked();
    expect(screen.queryByRole("button", { name: "Change selection" })).not.toBeInTheDocument();
  });

  it("defaults Odds shown to Best available and switches to a specific book without a request", async () => {
    await showPropsWithFourBooks();
    const odds = screen.getByLabelText("Odds shown");
    expect(odds).toHaveValue("");
    expect(screen.getByRole("option", { name: "Best available" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Next bookmaker")).not.toBeInTheDocument();
    const requests = fetchMock().mock.calls.length;

    fireEvent.change(odds, { target: { value: "bovada" } });
    expect(odds).toHaveValue("bovada");
    fireEvent.click(screen.getByText("Watch Over"));
    expect(useAppStore.getState().primaryWatch?.bookmakerKey).toBe("bovada");
    fireEvent.change(odds, { target: { value: "" } });
    expect(odds).toHaveValue("");
    fireEvent.click(screen.getByText("Watch Over"));
    expect(useAppStore.getState().primaryWatch?.bookmakerKey).toBe("draftkings");
    expect(fetchMock()).toHaveBeenCalledTimes(requests);
  });

  it("preserves a manual book across refreshes even when other books disappear", async () => {
    await showPropsWithFourBooks();
    const odds = screen.getByRole("combobox", { name: "Odds shown" });
    expect(odds).toHaveAccessibleName("Odds shown");
    fireEvent.change(odds, { target: { value: "bovada" } });
    for (const removeOtherBook of [false, true]) {
      const players = structuredClone(useAppStore.getState().discoveredProps);
      for (const market of players[0].markets) {
        for (const line of market.lines) if (line.bookmakerKey === "bovada" && line.side === "over") line.price = 2.2;
        if (removeOtherBook) market.lines = market.lines.filter((line) => line.bookmakerKey !== "fanduel");
      }
      mockFetchOnce({ success: true, dataSource: "live", eventId: "evt-1", players });
      const refresh = screen.getByRole("button", { name: "Refresh odds" });
      refresh.focus();
      fireEvent.click(refresh);
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh odds" })).toBeEnabled());
      expect(odds).toHaveValue("bovada");
      expect(refresh).toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: /Watch Over .*bovada for Jalen Hurts/ }));
      expect(useAppStore.getState().primaryWatch?.bookmakerKey).toBe("bovada");
    }
  });

  it("falls back with a notice if the manually chosen book disappears", async () => {
    await showPropsWithFourBooks();
    fireEvent.change(screen.getByLabelText("Odds shown"), { target: { value: "bovada" } });
    const players = structuredClone(useAppStore.getState().discoveredProps);
    for (const market of players[0].markets) market.lines = market.lines.filter((line) => line.bookmakerKey !== "bovada");
    mockFetchOnce({ success: true, dataSource: "live", eventId: "evt-1", players });
    fireEvent.click(screen.getByRole("button", { name: "Refresh odds" }));
    expect(await screen.findByText("The selected sportsbook is no longer quoted. Showing Best available.")).toBeInTheDocument();
    expect(screen.getByLabelText("Odds shown")).toHaveValue("");
    expect(screen.getByRole("button", { name: /Watch Over .*draftkings for Jalen Hurts/ })).toBeEnabled();
  });

  it("resets manual odds only when the selection changes", async () => {
    await showPropsWithFourBooks();
    fireEvent.change(screen.getByLabelText("Odds shown"), { target: { value: "bovada" } });
    const players = structuredClone(useAppStore.getState().discoveredProps);
    fireEvent.click(screen.getByRole("button", { name: "Change selection" }));
    fireEvent.click(screen.getByLabelText("Receptions"));
    mockFetchOnce({ success: true, dataSource: "live", eventId: "evt-1", players });
    fireEvent.click(screen.getByRole("button", { name: "Show props" }));
    await screen.findByRole("button", { name: "Change selection" });
    expect(screen.getByLabelText("Odds shown")).toHaveValue("");
    expect(screen.queryByText(/The selected sportsbook is no longer quoted/)).not.toBeInTheDocument();
  });

  it("discloses demo assignment only on demand and preserves the odds view through comparison", async () => {
    await showPropsWithFourBooks();
    expect(screen.getByText("Secondary (demo)")).not.toBeVisible();
    fireEvent.click(screen.getByText("Demo watch assignment"));
    expect(screen.getByRole("button", { name: "Primary" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Secondary (demo)" })).toBeInTheDocument();
    const odds = screen.getByLabelText("Odds shown");
    fireEvent.change(odds, { target: { value: "fanduel" } });
    const compare = screen.getByRole("button", { name: "Compare books" });
    fireEvent.click(compare);
    expect(odds).toBeDisabled();
    expect(compare).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(compare);
    expect(odds).toBeEnabled();
    expect(odds).toHaveValue("fanduel");
  });

  it("compare mode's book picker allows at most 3 selections, disabling the rest", async () => {
    await showPropsWithFourBooks();

    fireEvent.click(screen.getByRole("button", { name: "Compare books" }));
    fireEvent.click(screen.getByLabelText("betmgm"));
    fireEvent.click(screen.getByLabelText("bovada"));
    fireEvent.click(screen.getByLabelText("draftkings"));

    expect(screen.getByLabelText("fanduel")).toBeDisabled();
    expect(screen.getByLabelText("betmgm")).not.toBeDisabled(); // already-checked ones stay toggleable
  });

  it("Watch assigns to the primary slot by default, using the currently-effective book", async () => {
    await showPropsWithFourBooks();
    fireEvent.change(screen.getByLabelText("Odds shown"), { target: { value: "bovada" } });

    fireEvent.click(screen.getByText("Watch Over"));

    expect(screen.getByTestId("primary-watch-status")).toHaveTextContent(
      "Jalen Hurts — Passing Yards (over, bovada)"
    );
    expect(screen.queryByTestId("secondary-watch-status")).not.toBeInTheDocument();
  });

  it("lets the user explicitly watch Under and records that direction", async () => {
    await showPropsWithFourBooks();
    fireEvent.click(screen.getByText("Watch Under"));

    expect(useAppStore.getState().primaryWatch?.direction).toBe("under");
    expect(useAppStore.getState().primaryWatch?.bookmakerKey).toBe("bovada");
    expect(screen.getByTestId("primary-watch-status")).toHaveTextContent("under");
  });

  it("captures and labels the watched sportsbook, and refresh cannot silently retarget the existing watch", async () => {
    await showPropsWithFourBooks();
    expect(screen.queryByText("Track side:")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Watch Over .*draftkings for Jalen Hurts/ }));
    const watch = useAppStore.getState().primaryWatch;
    expect(screen.getByTestId("primary-watch-status")).toHaveTextContent("over, draftkings");
    const refreshed = structuredClone(useAppStore.getState().discoveredProps);
    for (const line of refreshed[0].markets[0].lines) {
      if (line.side === "over" && line.bookmakerKey === "bovada") line.price = 2.5;
    }
    mockFetchOnce({ success: true, dataSource: "live", eventId: "evt-1", players: refreshed });
    fireEvent.click(screen.getByRole("button", { name: "Refresh odds" }));
    expect(await screen.findByRole("button", { name: /Watch Over .*bovada for Jalen Hurts/ })).toBeEnabled();
    expect(useAppStore.getState().primaryWatch).toEqual(watch);
    expect(screen.getByTestId("primary-watch-status")).toHaveTextContent("over, draftkings");
    expect(screen.getByTestId("primary-watch-status")).not.toHaveTextContent("bovada");
  });

  it("switching the assign target to Secondary watches a second discovered prop without disturbing the primary one", async () => {
    await showPropsWithFourBooks();
    fireEvent.change(screen.getByLabelText("Odds shown"), { target: { value: "bovada" } });
    fireEvent.click(screen.getByText("Watch Over"));

    fireEvent.click(screen.getByText("Demo watch assignment"));
    fireEvent.click(screen.getByRole("button", { name: "Secondary (demo)" }));
    fireEvent.change(screen.getByLabelText("Odds shown"), { target: { value: "draftkings" } });
    fireEvent.click(screen.getByText("Watch Over"));

    expect(screen.getByTestId("primary-watch-status")).toHaveTextContent("bovada");
    expect(screen.getByTestId("secondary-watch-status")).toHaveTextContent("draftkings");
  });

  it("Clear removes one watch selection independently of the other", async () => {
    await showPropsWithFourBooks();
    fireEvent.change(screen.getByLabelText("Odds shown"), { target: { value: "bovada" } });
    fireEvent.click(screen.getByText("Watch Over"));
    fireEvent.click(screen.getByText("Demo watch assignment"));
    fireEvent.click(screen.getByRole("button", { name: "Secondary (demo)" }));
    fireEvent.click(screen.getByText("Watch Over"));

    fireEvent.click(screen.getAllByText("Clear")[0]);

    expect(screen.queryByTestId("primary-watch-status")).not.toBeInTheDocument();
    expect(screen.getByTestId("secondary-watch-status")).toBeInTheDocument();
  });

  it("shows a Refresh odds button only after props have been shown, and it requests with refresh=true", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, dataSource: "live", events: sampleEvents });

    render(<SlateBrowser />);
    fireEvent.change(await screen.findByLabelText("Select a game"), {
      target: { value: "evt-1" },
    });
    fireEvent.click(await screen.findByLabelText("Passing Yards"));

    expect(screen.queryByRole("button", { name: "Refresh odds" })).not.toBeInTheDocument();

    mockFetchOnce({
      success: true,
      dataSource: "live",
      eventId: "evt-1",
      players: [{ playerName: "Jalen Hurts", markets: [] }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Show props" }));
    await screen.findByText("Jalen Hurts");

    mockFetchOnce({ success: true, dataSource: "live", eventId: "evt-1", players: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh odds" }));

    await waitFor(() => {
      const lastCall = fetchMock().mock.calls.at(-1)?.[0] as string;
      expect(lastCall).toContain("refresh=true");
    });
  });
});
