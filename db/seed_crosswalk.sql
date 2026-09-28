-- #26: manual player_crosswalk seed, right-sized for the two players
-- currently seeded in src/store/mockData.ts. Looked up directly against
-- the synced player_game_stats table (nflverse's short-form player_name,
-- e.g. "D.Maye", not the Odds API's full "Drake Maye").
INSERT INTO player_crosswalk (odds_api_name, nflverse_player_id, nflverse_player_name)
VALUES
  ('Drake Maye', '00-0039851', 'D.Maye'),
  ('Sam Darnold', '00-0034869', 'S.Darnold')
ON CONFLICT (odds_api_name) DO UPDATE SET
  nflverse_player_id = EXCLUDED.nflverse_player_id,
  nflverse_player_name = EXCLUDED.nflverse_player_name;
