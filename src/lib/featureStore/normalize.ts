import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parse } from "csv-parse";
import { sha256 } from "./objectStore.ts";
import { checkLimits, INGEST_LIMITS, type IngestLimits, type SourceAsset } from "./source.ts";

export type NormalizedRow = Record<string, string | number | null | string[]>;
export type NormalizedFile = {
  rows: NormalizedRow[]; rowCount: number; wireSha256: string; decodedSha256: string;
  headerSha256: string; decodedBytes: number; diagnostics: Record<string, number>;
};
const playerId = /^00-\d{7}$/;
const gameId = /^(202[1-5])_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/;
const integer = (value: string): number | null => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const team = (value: string): boolean => /^[A-Z]{2,3}$/.test(value);
const eastern = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Same Eastern-time policy as main's pure schedule helper: round-trip both
// possible UTC offsets and refuse invalid, repeated or nonexistent local times.
export const easternKickoff = (day: string, time: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) throw new Error("schedule-clock-refused");
  const candidates = [4, 5].map((offset) => Date.parse(`${day}T${time}:00Z`) + offset * 3_600_000).filter((value) => {
    if (!Number.isFinite(value)) return false;
    const fields = Object.fromEntries(eastern.formatToParts(new Date(value)).map(({ type, value }) => [type, value]));
    return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}` === `${day}T${time}`;
  });
  if (candidates.length !== 1) throw new Error("schedule-clock-refused");
  return new Date(candidates[0]).toISOString();
};

export const normalizeSource = async (
  wire: Buffer, asset: SourceAsset, signal: AbortSignal, limits: IngestLimits = INGEST_LIMITS,
): Promise<NormalizedFile> => {
  checkLimits(limits);
  signal.throwIfAborted();
  if (wire.byteLength > limits.wireBytes || wire.byteLength !== asset.wire_bytes) throw new Error("ingest-wire-size-mismatch");
  const wireSha256 = sha256(wire);
  if ((asset.sha256 !== null && asset.sha256 !== wireSha256) ||
      (asset.provider_digest !== null && asset.provider_digest !== `sha256:${wireSha256}`)) throw new Error("ingest-wire-digest-mismatch");
  const decodedHash = createHash("sha256");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let decodedBytes = 0;
  const measured = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        decodedBytes += chunk.byteLength;
        if (decodedBytes > limits.decodedBytes) throw new Error("ingest-decoded-budget-exceeded");
        utf8.decode(chunk, { stream: true });
        decodedHash.update(chunk);
        callback(null, chunk);
      } catch (error) { callback(error as Error); }
    },
    flush(callback) { try { utf8.decode(); callback(); } catch (error) { callback(error as Error); } },
  });
  const rows = new Map<string, NormalizedRow>();
  const plays = new Map<string, { game: string; players: string[] | null; conflict: boolean }>();
  const diagnostics: Record<string, number> = { selectedRows: 0, filteredRows: 0, duplicateRows: 0, conflictingRows: 0,
    missingOffenseRows: 0, invalidParticipationRows: 0, refusedRows: 0 };
  let rowCount = 0;
  let headerSha256 = "";
  let header: string[] | undefined;
  const retain = (key: string, data: NormalizedRow, reasons: string[]) => {
    const row = { ...data, state: reasons.length ? "refused" : "usable", reasons };
    const existing = rows.get(key);
    if (!existing) { rows.set(key, row); return; }
    if (JSON.stringify(existing) === JSON.stringify(row)) { diagnostics.duplicateRows++; return; }
    diagnostics.conflictingRows++;
    rows.set(key, { ...existing, state: "ambiguous", reasons: ["conflicting-source-rows"] });
  };
  const consume = (fields: string[]) => {
    if (!header) {
      header = fields;
      if (!header.length || new Set(header).size !== header.length || JSON.stringify(header) !== JSON.stringify(asset.columns)) throw new Error("ingest-header-mismatch");
      headerSha256 = sha256(Buffer.from(JSON.stringify(header)));
      return;
    }
    if (++rowCount > limits.rows) throw new Error("ingest-row-budget-exceeded");
    const row = Object.fromEntries(header.map((name, index) => [name, fields[index]]));
    const reasons: string[] = [];
    if (asset.feed === "stats_player") {
      if (row.season_type !== "REG" || row.position !== "QB") { diagnostics.filteredRows++; return; }
      if (Number(row.season) !== asset.season) throw new Error("source-season-mismatch");
      const game = gameId.exec(row.game_id);
      if (!game || Number(game[1]) !== asset.season || Number(game[2]) !== Number(row.week) || Number(game[2]) < 1 || Number(game[2]) > 18) reasons.push("stats-game-scope-invalid");
      if (!playerId.test(row.player_id)) reasons.push("player-identity-invalid");
      if (!team(row.team) || (game && ![game[3], game[4]].includes(row.team))) reasons.push("stats-team-conflict");
      const attempts = integer(row.attempts), yards = integer(row.passing_yards);
      if (attempts === null || attempts < 0 || yards === null) reasons.push("stats-value-invalid");
      retain(`${row.player_id || "unresolved-" + rowCount}/${row.game_id}`, { player_id: row.player_id || `unresolved-${rowCount}`,
        game_id: row.game_id, team: row.team, passing_attempts: attempts !== null && attempts >= 0 ? attempts : null, passing_yards: yards }, reasons);
    } else if (asset.feed === "weekly_rosters") {
      if (row.game_type !== "REG" || row.position !== "QB") { diagnostics.filteredRows++; return; }
      const season = integer(row.season), week = integer(row.week);
      if (season !== asset.season || week === null || week < 1 || week > 18) throw new Error("source-season-mismatch");
      if (!playerId.test(row.gsis_id)) reasons.push("player-identity-invalid");
      if (!team(row.team)) reasons.push("roster-team-invalid");
      const id = row.gsis_id || `unresolved-${rowCount}`;
      retain(`${id}/${season}/${week}/${row.team}`, { player_id: id, season, week, team: row.team,
        display_name: row.full_name, position: "QB" }, reasons);
    } else if (asset.feed === "schedules") {
      const season = integer(row.season), week = integer(row.week);
      if (season === null || season < 2021 || season > 2025 || row.game_type !== "REG") { diagnostics.filteredRows++; return; }
      const game = gameId.exec(row.game_id);
      if (week === null || week < 1 || week > 18 || !game || Number(game[1]) !== season || Number(game[2]) !== week ||
          row.away_team !== game[3] || row.home_team !== game[4] || row.away_team === row.home_team) throw new Error("schedule-scope-refused");
      retain(row.game_id, { game_id: row.game_id, season, week, game_type: "REG", kickoff: easternKickoff(row.gameday, row.gametime),
        home_team: row.home_team, away_team: row.away_team, home_score: integer(row.home_score), away_score: integer(row.away_score) }, reasons);
    } else {
      const game = gameId.exec(row.nflverse_game_id);
      if (!game || Number(game[1]) !== asset.season) throw new Error("participation-game-scope-refused");
      if (Number(game[2]) > 18) { diagnostics.filteredRows++; return; }
      const play = integer(row.play_id);
      const raw = row.offense_players;
      let players: string[] | null = null;
      if (!raw || raw === "NA") diagnostics.missingOffenseRows++;
      else {
        // Public list formats are semicolon-separated GSIS identifiers. Accept
        // harmless whitespace, never extract valid-looking substrings from junk.
        const values = raw.split(";").map((value) => value.trim());
        if (values.every((value) => playerId.test(value)) && new Set(values).size === values.length) players = values.sort();
        else diagnostics.invalidParticipationRows++;
      }
      if (play === null || play < 0) { diagnostics.invalidParticipationRows++; return; }
      const key = `${row.nflverse_game_id}/${play}`;
      const previous = plays.get(key);
      if (previous) {
        diagnostics.duplicateRows++;
        if (JSON.stringify(previous.players) !== JSON.stringify(players)) { previous.conflict = true; diagnostics.conflictingRows++; }
      } else plays.set(key, { game: row.nflverse_game_id, players, conflict: false });
    }
  };
  const csv = parse({ bom: true, skip_empty_lines: false, relax_column_count: false, max_record_size: limits.recordBytes });
  const sink = async (source: AsyncIterable<string[]>) => { for await (const fields of source) { signal.throwIfAborted(); consume(fields); } };
  // Bounded chunks allow backpressure/cancellation and avoid materializing all
  // CSV rows or a second full decoded copy in memory.
  const chunks = function* () { for (let offset = 0; offset < wire.byteLength; offset += 64 * 1024) yield wire.subarray(offset, offset + 64 * 1024); };
  if (asset.name.endsWith(".csv.gz")) await pipeline(Readable.from(chunks()), createGunzip(), measured, csv, sink, { signal });
  else if (asset.name.endsWith(".csv")) await pipeline(Readable.from(chunks()), measured, csv, sink, { signal });
  else throw new Error("ingest-media-refused");
  if (!header || rowCount === 0) throw new Error("ingest-empty-csv");
  for (const play of plays.values()) {
    if (play.conflict || !play.players) continue;
    for (const player of play.players) {
      const key = `${player}/${play.game}`;
      const existing = rows.get(key);
      if (existing) existing.offense_play_count = Number(existing.offense_play_count) + 1;
      else rows.set(key, { player_id: player, game_id: play.game, offense_play_count: 1, state: "usable", reasons: [] });
    }
  }
  const selected = [...rows.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row);
  diagnostics.selectedRows = selected.length;
  diagnostics.refusedRows = selected.filter((row) => row.state !== "usable").length;
  return { rows: selected, rowCount, wireSha256, decodedSha256: decodedHash.digest("hex"), headerSha256, decodedBytes, diagnostics };
};
