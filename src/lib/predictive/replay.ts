import type { Dataset, Kind, Observation } from "./types.ts";
import { datasetContainer, instant, object, revisionKey, validateDataset } from "./validation.ts";

export type Selection<K extends Kind> = ({ state: "selected"; observation: Observation<K> } |
  { state: "missing" | "ambiguous"; observation: null }) & { dependencies: Observation[] };

export const createReplay = (dataset: Dataset, cutoff: string) => {
  const at = instant(cutoff);
  const root = datasetContainer(dataset);
  // Filter on the trusted capture routing envelope before parsing source bytes
  // or checking lineage. Future/diagnostic failures cannot poison old cutoffs.
  // Unparseable routing times are refused: their visibility cannot be decided.
  const captures = root.captures.filter((value) => {
    const capture = object(value);
    if (capture.state === "incomplete") return false;
    return instant(capture.availableAt) <= at && instant(capture.ingestedAt) <= at;
  });
  const artifactIds = new Set(captures.map((value) => object(value).artifactId));
  const artifacts = root.artifacts.filter((value) => value && typeof value === "object" &&
    !Array.isArray(value) && artifactIds.has((value as Record<string, unknown>).id));
  const validated = validateDataset({ formatVersion: 1, artifacts, captures });
  const active = [...validated.observations.values()];
  const superseded = new Set(active.map((row) => row.revision.predecessorId));
  const heads = active.filter((row) => !superseded.has(row.revision.id));
  const aliasGames = new Map<string, Set<string>>();
  for (const row of heads) {
    if (row.revision.kind !== "schedule") continue;
    const data = row.revision.data;
    const games = aliasGames.get(data.rawGameId) ?? new Set<string>();
    games.add(data.gameId); aliasGames.set(data.rawGameId, games);
  }
  return {
    select: <K extends Kind>(kind: K, key: string): Selection<K> => {
      const matches = heads.filter((row) => row.revision.kind === kind && revisionKey(row.revision) === key);
      if (matches.some((row) => row.revision.kind === "schedule" && aliasGames.get(row.revision.data.rawGameId)!.size > 1)) {
        const aliases = matches.flatMap((row) => row.revision.kind === "schedule" ? [row.revision.data.rawGameId] : []);
        const dependencies = heads.filter((row) => row.revision.kind === "schedule" && aliases.includes(row.revision.data.rawGameId));
        return { state: "ambiguous", observation: null, dependencies };
      }
      return matches.length === 1 ? { state: "selected", observation: matches[0] as Observation<K>, dependencies: matches } :
        { state: matches.length ? "ambiguous" : "missing", observation: null, dependencies: matches };
    },
    // Enumerate cutoff-known schedules only; a future capture cannot invent a
    // prior-game gap or reveal a future identity to an earlier replay.
    keys: (kind: Kind): string[] => [...new Set(heads.filter((row) => row.revision.kind === kind).map((row) => revisionKey(row.revision)))].sort(),
  };
};
