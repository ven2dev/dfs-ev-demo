import "server-only";
// open-meteo.com requires no API key, so there's no secret to protect
// here, but it's still enforced server-only for consistency with the
// app's "server fetches, clients receive" data-flow convention.

export type WeatherSnapshot = {
  temperatureF: number;
  windSpeedMph: number;
  precipitationMm: number;
};

// Fetches the FORECAST for the game's actual kickoff time, not "current"
// conditions — the game may be days away, and today's weather has no
// bearing on conditions during the game itself. Venue coordinates are
// caller-supplied (the matchup's own venueLat/venueLon), not hardcoded
// here -- a hardcoded venue silently mislabels every OTHER matchup's
// weather as "real" when it's actually a different city's forecast
// (a real bug found in review after the seeded matchup rotated from
// Seattle to Chicago and this function kept fetching Seattle's).
export async function fetchGameWeather(
  gameTimeIso: string,
  venueLat: number,
  venueLon: number,
  signal?: AbortSignal
): Promise<WeatherSnapshot | null> {
  const gameDate = new Date(gameTimeIso);
  const dateStr = gameDate.toISOString().slice(0, 10);

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${venueLat}` +
    `&longitude=${venueLon}&hourly=temperature_2m,wind_speed_10m,precipitation` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph` +
    `&start_date=${dateStr}&end_date=${dateStr}`;

  const res = await fetch(url, { cache: "no-store", signal });
  if (!res.ok) {
    return null;
  }
  const data = await res.json();
  const times: string[] = data.hourly?.time ?? [];
  if (times.length === 0) {
    return null;
  }

  // Pick the hourly entry closest to actual kickoff.
  let closestIndex = 0;
  let closestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(new Date(`${times[i]}:00Z`).getTime() - gameDate.getTime());
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIndex = i;
    }
  }

  return {
    temperatureF: data.hourly.temperature_2m[closestIndex],
    windSpeedMph: data.hourly.wind_speed_10m[closestIndex],
    precipitationMm: data.hourly.precipitation[closestIndex],
  };
}
