-- Align the predictive team constraint with NFL_TEAM_ABBREVIATIONS.
-- V3 incorrectly accepted LAR, while the application's canonical Rams ID is LA.
-- Keep v3 bytes/checksums intact. Validate existing rows rather than rewriting
-- immutable identities or observations; an unmapped legacy LAR row refuses the
-- migration and the runner rolls back its DDL and ledger insertion.
ALTER TABLE public.predictive_teams
  DROP CONSTRAINT predictive_teams_id_check,
  ADD CONSTRAINT predictive_teams_id_check
    CHECK (id ~ '^nfl:team:(ARI|ATL|BAL|BUF|CAR|CHI|CIN|CLE|DAL|DEN|DET|GB|HOU|IND|JAX|KC|LA|LAC|LV|MIA|MIN|NE|NO|NYG|NYJ|PHI|PIT|SEA|SF|TB|TEN|WAS)$');
