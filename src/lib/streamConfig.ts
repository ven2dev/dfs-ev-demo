// Shared between the server route and the client hook so they can't
// drift out of sync (e.g. the client marking the connection "stale"
// before the server's own poll interval has even had a chance to fire).
export const POLL_INTERVAL_MS = 90000;
export const MAX_TICKS = 20;

// Comfortably longer than one poll interval so a single delayed/slow
// tick doesn't cause a false "stale" flag.
export const STALE_TIMEOUT_MS = POLL_INTERVAL_MS * 3;
