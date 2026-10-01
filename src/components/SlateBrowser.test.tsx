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
  const response =
    typeof data === "object" && data !== null && "events" in data && !("window" in data)
      ? { ...data, window: sampleWindow }
      : data;
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
  it("titles the section with the real current NFL week, not a static label", async () => {
    // shouldAdvanceTime: pins Date.now() while still letting RTL's own
    // internal setTimeout-based polling (findByText, waitFor) actually
    // tick -- plain useFakeTimers() freezes those too and hangs forever.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z")); // verified real Week 4 (see nflWeek.test.ts)
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, events: [] });

    render(<SlateBrowser />);

    expect(await screen.findByText("Browse the Week 4 slate")).toBeInTheDocument();
  });

  it("loads the real slate on mount and lists games sorted by kickoff time, not arrival order", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, events: sampleEvents });

    render(<SlateBrowser />);

    const select = await screen.findByLabelText("Select a game");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options[1]).toContain("Pittsburgh Steelers @ Cleveland Browns");
    expect(options[2]).toContain("Green Bay Packers @ Chicago Bears");
  });

  it("refreshes the server-owned slate when the tab regains focus", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, events: sampleEvents });

    render(<SlateBrowser />);
    await screen.findByLabelText("Select a game");

    mockFetchOnce({ success: true, events: [sampleEvents[0]] });
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
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

  it("ignores a discovery response after the selected event changes", async () => {
    global.fetch = vi.fn();
    mockFetchOnce({ success: true, events: sampleEvents });

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
    mockFetchOnce({ success: true, events: sampleEvents });

    render(<SlateBrowser />);
    fireEvent.change(await screen.findByLabelText("Select a game"), {
      target: { value: "evt-1" },
    });
    fireEvent.click(await screen.findByLabelText("Passing Yards"));

    mockFetchOnce({
      success: true,
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

  it("starts on the direction-aware smart price default, and cycling switches to a manual override starting from the first book alphabetically, wrapping around", async () => {
    await showPropsWithFourBooks();
    const stepperLabel = () => screen.getByTestId("bookmaker-stepper-label");

    expect(stepperLabel()).toHaveTextContent("Best Over price");
    expect(screen.queryByText("Reset to best")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Next bookmaker"));
    expect(stepperLabel()).toHaveTextContent("bovada"); // one past "betmgm", the alphabetically-first book
    expect(screen.getByText("Reset to best")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Next bookmaker"));
    expect(stepperLabel()).toHaveTextContent("draftkings");

    fireEvent.click(screen.getByLabelText("Previous bookmaker"));
    expect(stepperLabel()).toHaveTextContent("bovada");

    // Wrap backward from the first book to the last.
    fireEvent.click(screen.getByLabelText("Previous bookmaker"));
    fireEvent.click(screen.getByLabelText("Previous bookmaker"));
    expect(stepperLabel()).toHaveTextContent("fanduel");

    fireEvent.click(screen.getByText("Reset to best"));
    expect(stepperLabel()).toHaveTextContent("Best Over price");
    expect(screen.queryByText("Reset to best")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByLabelText("Next bookmaker")); // manual override -> "bovada"

    fireEvent.click(screen.getByText("Watch Over"));

    expect(screen.getByTestId("primary-watch-status")).toHaveTextContent(
      "Jalen Hurts — Passing Yards (over, bovada)"
    );
    expect(screen.queryByTestId("secondary-watch-status")).not.toBeInTheDocument();
  });

  it("lets the user explicitly watch Under and records that direction", async () => {
    await showPropsWithFourBooks();
    fireEvent.click(screen.getByRole("button", { name: "under" }));
    fireEvent.click(screen.getByText("Watch Under"));

    expect(useAppStore.getState().primaryWatch?.direction).toBe("under");
    expect(useAppStore.getState().primaryWatch?.bookmakerKey).toBe("bovada");
    expect(screen.getByTestId("primary-watch-status")).toHaveTextContent("under");
  });

  it("switching the assign target to Secondary watches a second real prop without disturbing the primary one", async () => {
    await showPropsWithFourBooks();
    fireEvent.click(screen.getByLabelText("Next bookmaker")); // -> "bovada"
    fireEvent.click(screen.getByText("Watch Over"));

    fireEvent.click(screen.getByRole("button", { name: "Secondary (demo)" }));
    fireEvent.click(screen.getByLabelText("Next bookmaker")); // -> "draftkings"
    fireEvent.click(screen.getByText("Watch Over"));

    expect(screen.getByTestId("primary-watch-status")).toHaveTextContent("bovada");
    expect(screen.getByTestId("secondary-watch-status")).toHaveTextContent("draftkings");
  });

  it("Clear removes one watch selection independently of the other", async () => {
    await showPropsWithFourBooks();
    fireEvent.click(screen.getByLabelText("Next bookmaker"));
    fireEvent.click(screen.getByText("Watch Over"));
    fireEvent.click(screen.getByRole("button", { name: "Secondary (demo)" }));
    fireEvent.click(screen.getByText("Watch Over"));

    fireEvent.click(screen.getAllByText("Clear")[0]);

    expect(screen.queryByTestId("primary-watch-status")).not.toBeInTheDocument();
    expect(screen.getByTestId("secondary-watch-status")).toBeInTheDocument();
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
