-- #26: manual player_crosswalk seed. Looked up directly against the
-- synced player_game_stats table (nflverse's short-form player_name,
-- e.g. "J.Hurts", not the Odds API's full "Jalen Hurts").
--
-- As of #27's real slate ingestion, a user can Watch any real player
-- from the live discovery UI, not just one seeded example -- so this is
-- now an ADDITIVE, growing list (append a row here whenever a newly-
-- watched player needs real historical stats), not a per-rotation
-- replacement. #32 (crosswalk auto-matching) is what eventually makes
-- this automatic at roster scale; until then, ON CONFLICT upserts a
-- re-added player's IDs rather than erroring, but nothing here deletes
-- an existing player's row -- a prior version did (matching the old
-- single-seeded-matchup model), which would incorrectly wipe out any
-- OTHER player a user had already crosswalked by watching them for
-- real. Deleting a row here would also strand that player's
-- already-synced player_game_stats rows as effectively unreachable
-- (kept, but no longer resolvable by name) -- another reason this
-- stays append-only.
INSERT INTO player_crosswalk (odds_api_name, nflverse_player_id, nflverse_player_name)
VALUES
  ('Jalen Hurts', '00-0036389', 'J.Hurts'),
  ('Saquon Barkley', '00-0034844', 'S.Barkley')
ON CONFLICT (odds_api_name) DO UPDATE SET
  nflverse_player_id = EXCLUDED.nflverse_player_id,
  nflverse_player_name = EXCLUDED.nflverse_player_name;
