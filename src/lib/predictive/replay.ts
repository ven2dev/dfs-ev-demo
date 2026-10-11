import type { CompletionRecord, Dataset, Decision, Kind, Observation, ParticipationRecord, Reconciliation, RightsDecision } from "./types.ts";
import { completionFromHeads, validateCompletionDecisions } from "./completion.ts";
import { participationFromHeads, validateParticipationDecisions } from "./participation.ts";
import { allows, canonical, compareText, datasetContainer, instant, object, rightsInForce, validateDataset, validateDecisions, validateObservations } from "./validation.ts";

export type Selection<K extends Kind> = ({ state: "selected"; observation: Observation<K> } |
  { state: "missing" | "ambiguous" | "absent"; observation: null }) & { dependencies: Observation[] };

// Current access: evidence is usable now only while its profile's rights in
// force now allow model input. Earlier authorization is audit, not permission.
export const blockedProfiles = (decisions: RightsDecision[], profileIds: Iterable<string>, accessAt: string) => {
  const at = instant(accessAt);
  return new Set([...profileIds].filter((id) => !allows(rightsInForce(decisions, id, at, at), "model-input")));
};

export const createReplay = (dataset: Dataset, cutoff: string, accessAt: string) => {
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
  // Only decisions known by the cutoff can resolve anything at that cutoff.
  const decisions = root.decisions.filter((value) => instant(object(value).decidedAt) <= at);
  const validated = validateDataset({ ...root, artifacts, captures, decisions });
  validateDecisions(validated.decisions, validated.observations, validated.profiles);
  validateCompletionDecisions(validated.decisions, validated.observations, validated.profiles);
  validateParticipationDecisions(validated.decisions, validated.observations, validated.profiles);
  const rows = [...validated.observations.values()];
  return replayObservations(rows, blockedProfiles(validated.rightsDecisions, new Set(rows.map((row) => row.artifact.profileId)), accessAt), validated.decisions);
};

// Persistent reads supply only validated, cutoff-visible source chains. Each
// source chain contributes its head; one fact with several provider heads is
// ambiguous until a reconciliation decision selects one.
export const replayObservations = (rows: Observation[], blocked: Set<string>, decisions: Decision[] = []) => {
  const active = [...validateObservations(rows).values()].filter((row) => !blocked.has(row.artifact.profileId));
  const superseded = new Set(active.map((row) => row.revision.predecessorId));
  const heads = active.filter((row) => !superseded.has(row.revision.id));
  const replacedDecisions = new Set(decisions.map((decision) => decision.predecessorId));
  const decisionHeads = new Map<string, Decision[]>();
  for (const decision of decisions.filter((item) => !replacedDecisions.has(item.id))) {
    decisionHeads.set(decision.entityKey, [...(decisionHeads.get(decision.entityKey) ?? []), decision]);
  }
  const cited = new Map<string, CompletionRecord>();
  const citedParticipation = new Map<string, ParticipationRecord>();
  const sameIds = (record: Decision, rows: Observation[]) =>
    record.inputs.map((input) => input.observationId).sort(compareText).join("\n") === rows.map((row) => row.revision.id).sort(compareText).join("\n");
  const used = new Map<string, Reconciliation>();
  const disappeared = new Map<string, Observation[]>();
  // A decision resolves a fact only for the exact provider heads it judged. A
  // later correction or a new provider makes it stale, and the fact ambiguous.
  const reconciled = (key: string, matches: Observation[]) => {
    const latest = (decisionHeads.get("reconciliation:" + key) ?? []) as Reconciliation[];
    if (latest.length !== 1 || latest[0].outcome.result !== "selected") return null;
    const judged = latest[0].inputs.map((input) => input.observationId).sort(compareText);
    const current = matches.map((row) => row.revision.id).sort(compareText);
    if (judged.join("\n") !== current.join("\n")) return null;
    used.set(latest[0].id, latest[0]);
    return matches.find((row) => row.revision.id === latest[0].outcome.selectedObservationId) ?? null;
  };
  const aliasGames = new Map<string, Set<string>>();
  for (const row of heads) {
    if (row.revision.kind !== "schedule") continue;
    const data = row.revision.data;
    const games = aliasGames.get(data.rawGameId) ?? new Set<string>();
    games.add(data.gameId); aliasGames.set(data.rawGameId, games);
  }
  return {
    blockedProfiles: [...blocked].sort(),
    select: <K extends Kind>(kind: K, key: string): Selection<K> => {
      // absence-v1: a provider chain whose head is an absence withholds the fact.
      const absent = heads.filter((row) => row.revision.kind === "source-row-absent" && row.entityKey === key);
      if (absent.length) {
        disappeared.set(key, absent);
        return { state: "absent", observation: null, dependencies: heads.filter((row) => row.entityKey === key) };
      }
      const matches = heads.filter((row) => row.revision.kind === kind && row.entityKey === key);
      if (matches.some((row) => row.revision.kind === "schedule" && aliasGames.get(row.revision.data.rawGameId)!.size > 1)) {
        const aliases = matches.flatMap((row) => row.revision.kind === "schedule" ? [row.revision.data.rawGameId] : []);
        const dependencies = heads.filter((row) => row.revision.kind === "schedule" && aliases.includes(row.revision.data.rawGameId));
        return { state: "ambiguous", observation: null, dependencies };
      }
      if (matches.length > 1) {
        const chosen = reconciled(key, matches);
        if (chosen) return { state: "selected", observation: chosen as Observation<K>, dependencies: matches };
      }
      return matches.length === 1 ? { state: "selected", observation: matches[0] as Observation<K>, dependencies: matches } :
        { state: matches.length ? "ambiguous" : "missing", observation: null, dependencies: matches };
    },
    // Current provider heads for one fact, for producing reconciliation decisions.
    heads: (key: string): Observation[] => heads.filter((row) => row.entityKey === key),
    usedDecisions: () => [...used.values()].sort((a, b) => compareText(a.id, b.id)),
    // event-completion-v1 over the current marker heads (absences included). A
    // persisted record is cited only if it judged exactly these heads and agrees.
    completion: (gameId: string) => {
      const markers = heads.filter((row) => row.entityKey.startsWith("event-state-marker:" + gameId + ":"));
      const outcome = completionFromHeads(markers);
      const latest = (decisionHeads.get("completion:" + gameId) ?? []) as CompletionRecord[];
      const judged = (record: CompletionRecord) => record.inputs.map((input) => input.observationId).sort(compareText).join("\n");
      const current = markers.map((row) => row.revision.id).sort(compareText).join("\n");
      if (latest.length === 1 && judged(latest[0]) === current && canonical(latest[0].outcome) === canonical(outcome)) cited.set(latest[0].id, latest[0]);
      return { ...outcome, inputs: markers };
    },
    citedCompletions: () => [...cited.values()].sort((a, b) => compareText(a.id, b.id)),
    // participation-v1 over the current evidence and stats heads for one
    // player-game, citing a record only if it judged exactly these heads.
    participation: (gameId: string, playerId: string) => {
      const prefix = "participation-evidence:" + gameId + ":" + playerId + ":"; const stats = "player-game-stats:" + gameId + ":" + playerId;
      const scope = heads.filter((row) => row.entityKey.startsWith(prefix) || row.entityKey === stats);
      const outcome = participationFromHeads(scope);
      const latest = (decisionHeads.get("participation:" + gameId + ":" + playerId) ?? []) as ParticipationRecord[];
      if (latest.length === 1 && sameIds(latest[0], scope) && canonical(latest[0].outcome) === canonical(outcome)) citedParticipation.set(latest[0].id, latest[0]);
      return { ...outcome, inputs: scope };
    },
    // bridge-v1 resolution: one canonical identity from the current heads for a
    // provider's raw ID, effective at the requested time. Disagreeing providers
    // or a disappeared mapping resolve as unresolved, never by choosing one.
    resolvePlayer: (provider: string, rawPlayerId: string, at: string) => resolveBridge(heads, "player-bridge:" + provider + ":" + rawPlayerId,
      (row) => row.revision.kind === "player-bridge" && instant(row.revision.data.effectiveFrom) <= instant(at) && instant(at) < instant(row.revision.data.effectiveTo),
      (row) => (row.revision.data as { playerId: string }).playerId),
    resolveTeam: (provider: string, rawAlias: string, season: number) => resolveBridge(heads, "team-alias:" + provider + ":" + rawAlias,
      (row) => row.revision.kind === "team-alias" && row.revision.data.effectiveFromSeason <= season && season <= row.revision.data.effectiveToSeason,
      (row) => (row.revision.data as { teamId: string }).teamId),
    resolveGame: (provider: string, rawGameId: string) => resolveBridge(heads, "game-bridge:" + provider + ":" + rawGameId,
      (row) => row.revision.kind === "game-bridge", (row) => (row.revision.data as { gameId: string }).gameId),
    replacementOf: (gameId: string) => resolveBridge(heads, "game-relation:" + gameId,
      (row) => row.revision.kind === "game-relation", (row) => (row.revision.data as { predecessorGameId: string }).predecessorGameId),
    citedParticipations: () => [...citedParticipation.values()].sort((a, b) => compareText(a.id, b.id)),
    disappearedFacts: () => [...disappeared.keys()].sort(compareText),
    // Enumerate cutoff-known facts only; a future capture cannot invent a
    // prior-game gap or reveal a future identity to an earlier replay.
    keys: (kind: Kind): string[] => [...new Set(heads.filter((row) => row.revision.kind === kind).map((row) => row.entityKey))].sort(),
  };
};
export type Replay = ReturnType<typeof replayObservations>;

export type BridgeResolution = { state: "resolved"; value: string; dependencies: Observation[] } |
  { state: "missing" | "unresolved"; value: null; reason: "identity-bridge-missing" | "identity-bridge-conflict"; dependencies: Observation[] };
const resolveBridge = (heads: Observation[], key: string, applies: (row: Observation) => boolean, value: (row: Observation) => string): BridgeResolution => {
  const rows = heads.filter((row) => row.entityKey === key);
  if (rows.some((row) => row.revision.kind === "source-row-absent")) return { state: "unresolved", value: null, reason: "identity-bridge-conflict", dependencies: rows };
  const values = [...new Set(rows.filter(applies).map(value))];
  if (values.length === 1) return { state: "resolved", value: values[0], dependencies: rows };
  return values.length ? { state: "unresolved", value: null, reason: "identity-bridge-conflict", dependencies: rows } :
    { state: "missing", value: null, reason: "identity-bridge-missing", dependencies: rows };
};
