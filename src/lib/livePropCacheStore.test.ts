import { describe, expect, it, vi } from "vitest";
import { createLivePropCacheStore } from "./livePropCacheStore";

const key = {
  sportKey: "americanfootball_nfl",
  eventId: "evt-1",
  marketKey: "player_pass_yds",
  playerName: "Jalen Hurts",
};

describe("createLivePropCacheStore", () => {
  it("keeps each store bound to its own query adapter without querying during construction", async () => {
    const fetchedAt = "2026-10-04T12:00:00.000Z";
    const payload = {
      oddsByBookmaker: [],
      weather: { temperatureF: 62, windSpeedMph: 8, precipitationMm: 0 },
    };
    const firstQuery = vi.fn().mockResolvedValue([
      { payload, fetched_at: fetchedAt },
    ]);
    const secondQuery = vi.fn().mockResolvedValue([]);

    const firstStore = createLivePropCacheStore(firstQuery);
    const secondStore = createLivePropCacheStore(secondQuery);
    expect(firstQuery).not.toHaveBeenCalled();
    expect(secondQuery).not.toHaveBeenCalled();

    await expect(firstStore.read(key)).resolves.toEqual({
      payload,
      fetchedAtMs: Date.parse(fetchedAt),
    });
    expect(secondQuery).not.toHaveBeenCalled();
    await expect(secondStore.read(key)).resolves.toBeNull();
    expect(firstQuery).toHaveBeenCalledTimes(1);
    expect(secondQuery).toHaveBeenCalledTimes(1);
  });
});
