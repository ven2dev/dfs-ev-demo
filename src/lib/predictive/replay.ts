import type { Dataset, Kind, Observation, Revision } from "./types.ts";
import { canonical, compareText, instant, refuse, revisionKey, validateDataset } from "./validation.ts";

export type Selection<K extends Kind> = ({ state: "selected"; observation: Observation<K> } |
  { state: "missing" | "ambiguous"; observation: null }) & { dependencies: Observation[] };

export function createReplay(dataset: Dataset, cutoff: string) {
  const at = instant(cutoff);
  const validated = validateDataset(dataset);
  const artifacts = new Map(dataset.artifacts.map((artifact) => [artifact.id, artifact]));
  const observations = new Map<string, Observation>();
  const eligible = new Set<string>();
  function captureOrder(a: Observation, b: Observation): number {
    return instant(a.capture.ingestedAt) - instant(b.capture.ingestedAt) ||
      instant(a.capture.availableAt) - instant(b.capture.availableAt) ||
      instant(a.capture.capturedAt) - instant(b.capture.capturedAt) ||
      compareText(a.capture.id, b.capture.id);
  }
  for (const capture of dataset.captures) {
    if (capture.state !== "published") continue;
    const artifact = artifacts.get(capture.artifactId)!;
    const known = instant(capture.availableAt) <= at && instant(capture.ingestedAt) <= at;
    for (const revision of validated.revisions.get(capture.artifactId)!) {
      const row = { revision, capture, artifact };
      const previous = observations.get(revision.id);
      if (previous && canonical(previous.revision) !== canonical(revision)) refuse("observation-id-conflict");
      // Same immutable revision recaptured later keeps its earliest usable
      // capture. It never backdates an actually late import.
      if (!previous || captureOrder(row, previous) < 0) observations.set(revision.id, row);
      if (known) eligible.add(revision.id);
    }
  }
  for (const row of observations.values()) {
    const revision = row.revision;
    if (revision.predecessorId !== null) {
      const prior = observations.get(revision.predecessorId);
      if (!prior || revisionKey(prior.revision) !== revisionKey(revision) ||
          instant(prior.capture.availableAt) > instant(row.capture.availableAt) ||
          instant(prior.capture.ingestedAt) > instant(row.capture.ingestedAt)) refuse("invalid-correction-lineage");
      const seen = new Set([revision.id]);
      let ancestor: Revision | undefined = prior.revision;
      while (ancestor) {
        if (seen.has(ancestor.id)) refuse("cyclic-correction-lineage");
        seen.add(ancestor.id);
        ancestor = ancestor.predecessorId === null ? undefined : observations.get(ancestor.predecessorId)?.revision;
      }
    }
  }
  const active = [...observations.values()].filter((row) => eligible.has(row.revision.id));
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
    select<K extends Kind>(kind: K, key: string): Selection<K> {
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
    keys(kind: Kind): string[] { return [...new Set(heads.filter((row) => row.revision.kind === kind).map((row) => revisionKey(row.revision)))].sort(); },
  };
}
