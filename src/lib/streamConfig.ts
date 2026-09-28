// Shared between the server route and the client hook so they can't
// drift out of sync (e.g. the client marking the connection "stale"
// before the server's own poll interval has even had a chance to fire).
export const POLL_INTERVAL_MS = 90000;
export const MAX_TICKS = 20;

// Comfortably longer than one poll interval so a single delayed/slow
// tick doesn't cause a false "stale" flag.
export const STALE_TIMEOUT_MS = POLL_INTERVAL_MS * 3;

export const DEFAULT_SAMPLE_WINDOW = 5;

// EventSource can't send a request body or custom headers, so the
// client's sampleWindow selection has to travel as a query param --
// this is the one place both the hook (building the URL) and the route
// (reading it) agree on what a valid value looks like, so they can't
// drift into disagreeing about what an invalid/missing value defaults
// to.
export const parseSampleWindow = (value: string | null): 3 | 5 | 7 => {
  if (value === "3" || value === "5" || value === "7") {
    return Number(value) as 3 | 5 | 7;
  }
  return DEFAULT_SAMPLE_WINDOW;
};
