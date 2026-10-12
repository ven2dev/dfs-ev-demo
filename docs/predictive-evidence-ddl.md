# `0003_predictive_evidence.sql`: column-level DDL, revision 2

Status: **implemented in PR A** on `feature/dfsEV-52-evidence-schema` (steps 1–10
and both implementation review rounds, through 2026-10-11). Sections 1–13 are the
approved design; section 14 records what each step and review fix built and where
it refined the design. Independent review approved `d5c5c71` on 2026-10-11;
0003 is now frozen under section 12. Further schema changes require a new
forward migration.

Revision 2 consolidates the owner decisions of 2026-10-10 (scoped deletion, saving
every feature run, bridges as evidence) and the second design review (rights
knowledge time, the privilege boundary, absence routing, label binding, the
feature-run write path, the reset test, the regeneration procedure, retention
consistency). It implements [`predictive-real-source-schema.md`](predictive-real-source-schema.md)
revision 2.

Conventions are carried from synthetic v3: `predictive_` prefix, text IDs, strict
UTC millisecond instants (`isfinite`, `date_trunc('milliseconds')`) on every
`timestamptz`, append-only triggers, and deferred constraint triggers.
**Every function is created with explicit privileges** (section 10). The
migration seeds only the 32 teams.

---

## 1. Shared helpers

Carried over: `predictive_text`, `predictive_instant`, `predictive_integer`.
New, all `IMMUTABLE STRICT`, with schema-qualified references:

- `predictive_entity_key(kind, data)`: section 11.
- `predictive_payload_valid(kind, data)`: exact keys + per-kind rules, section 11.
- `predictive_decision_valid(kind, outcome)`.
- `predictive_label_eligible_final_at(bound timestamptz)`: the later of
  `bound + 72h` and the first Thursday 12:00 UTC strictly after `bound`.

**Key exception, documented:** entity keys never include the *evidence
provider*, so two providers' claims about the same fact share an entity key.
Bridge kinds are the exception by necessity: they are keyed by
`provider + raw ID` because the raw ID is only meaningful inside that provider.

## 2. Registration and rights

```sql
CREATE TABLE public.predictive_source_profiles (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9.-]{2,127}$'),
  purpose text NOT NULL CHECK (purpose IN ('source','owner-decision','synthetic-test')),
  provider text NOT NULL, feed text NOT NULL, release_tag text, asset_pattern text,
  header_profile_sha256 text CHECK (header_profile_sha256 ~ '^[a-f0-9]{64}$'),
  parser_version text NOT NULL, allowlist_version text NOT NULL,
  license text NOT NULL, attribution text,
  registered_at timestamptz NOT NULL
);

CREATE TABLE public.predictive_rights_decisions (
  id text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES public.predictive_source_profiles(id),
  predecessor_id text,
  allowed_uses text[] NOT NULL CHECK (allowed_uses <@ ARRAY['adapter-testing','internal-research',
                 'model-input','outcome-label','public-display']::text[]),
  effective_from timestamptz NOT NULL,      -- effective time: when the terms apply
  effective_to   timestamptz CHECK (effective_to IS NULL OR effective_to > effective_from),
  decided_at     timestamptz NOT NULL,      -- knowledge time: when we recorded it
  evidence_kind  text NOT NULL CHECK (evidence_kind IN ('terms-review','written-confirmation',
                 'license-file','revocation','synthetic')),
  evidence_reference text NOT NULL,
  UNIQUE (id, profile_id),
  FOREIGN KEY (predecessor_id, profile_id) REFERENCES public.predictive_rights_decisions(id, profile_id),
  UNIQUE (predecessor_id),                  -- no branching: at most one successor
  CHECK (predecessor_id IS DISTINCT FROM id),
  CHECK (evidence_kind <> 'revocation' OR allowed_uses = '{}')
);
CREATE UNIQUE INDEX predictive_rights_one_root ON public.predictive_rights_decisions (profile_id)
  WHERE predecessor_id IS NULL;             -- one linear chain per profile
```

Deferred check: a successor's `decided_at` ≥ its predecessor's.

```sql
-- The decision that applies to effective instant e, using only decisions known by
-- instant k: the LAST link of the profile's chain with decided_at <= k whose
-- effective interval contains e. The chain is linear, so there are no ties.
-- No match means not authorized.
CREATE FUNCTION public.predictive_rights_in_force(profile text, e timestamptz, k timestamptz)
RETURNS public.predictive_rights_decisions LANGUAGE sql STABLE ...;
```

Two uses, never mixed:

- **Historical authorization (audit):** at publication, the run must be authorized
  by `predictive_rights_in_force(profile, captured_at, captured_at)`. A decision
  recorded later with a backdated `effective_from` can't authorize an earlier run.
  The decision ID is stored in `predictive_run_rights`.
- **Current access:** every feature construction and label read checks
  `predictive_rights_in_force(profile, now(), now())` for the use it needs
  (`model-input` / `outcome-label`). A later restriction takes effect immediately
  without rewriting the run's audit record.

**Synthetic data (one consistent exception):** synthetic-test profiles may carry
any use except `public-display`. Any feature run, label or decision whose
transitive evidence includes a synthetic profile must have
`mode = 'synthetic-proof'`. Rows in that mode can only be inserted by a session
that is a member of the `predictive_harness` role (`pg_has_role(session_user, ...)`,
**not a settable flag**). That role exists only in the disposable harness. Real
reads filter `mode = 'production-research'`. A trial profile
(`adapter-testing` only) can never satisfy `model-input` and so never enters a
feature run.

## 3. Bytes, runs and captures

```sql
CREATE TABLE public.predictive_blobs (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 0 AND 64000000),
  media_type text NOT NULL CHECK (media_type IN ('text/csv','application/json')),
  storage_ref text NOT NULL CHECK (storage_ref = sha256)
);

CREATE TABLE public.predictive_ingestion_runs (
  id text PRIMARY KEY, request_sha256 text NOT NULL, code_version text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL CHECK (finished_at >= started_at),
  status text NOT NULL CHECK (status IN ('published','incomplete','refused')),
  failure_code text CHECK (failure_code IN ('publication-refused','artifact-store-unavailable',
    'partial-acquisition','budget-exceeded','rights-not-in-force')),
  budget jsonb NOT NULL, requests integer NOT NULL, consumed_bytes bigint NOT NULL,
  row_count integer NOT NULL, peak_rss_bytes bigint,
  CHECK ((status = 'published') = (failure_code IS NULL))
);
CREATE TABLE public.predictive_run_rights (
  run_id text NOT NULL REFERENCES public.predictive_ingestion_runs(id),
  rights_decision_id text NOT NULL REFERENCES public.predictive_rights_decisions(id),
  PRIMARY KEY (run_id, rights_decision_id)
);

CREATE TABLE public.predictive_artifacts (
  id text PRIMARY KEY,
  blob_sha256 text NOT NULL REFERENCES public.predictive_blobs(sha256),
  profile_id text NOT NULL REFERENCES public.predictive_source_profiles(id),
  retrieval_kind text NOT NULL CHECK (retrieval_kind IN ('full','header-probe')),
  origin_url text NOT NULL CHECK (origin_url ~ '^(https|fixture)://'),
  provider_etag text, provider_last_modified text,
  release_updated_at timestamptz,           -- diagnostic only, never availability
  scope_kind text NOT NULL CHECK (scope_kind IN ('season-file','week-file','game','all-seasons','manual')),
  scope_season integer, scope_week integer, scope_filter text,
  CHECK ((scope_kind = 'week-file') = (scope_week IS NOT NULL))
);

CREATE TABLE public.predictive_captures (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES public.predictive_ingestion_runs(id),
  artifact_id text NOT NULL REFERENCES public.predictive_artifacts(id),
  captured_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL CHECK (available_at >= captured_at),
  ingested_at timestamptz NOT NULL CHECK (ingested_at >= available_at),
  published_at timestamptz CHECK (published_at <= captured_at), publication_evidence text,
  state text NOT NULL CHECK (state IN ('published','incomplete')),
  body_complete boolean NOT NULL, header_verified boolean NOT NULL,
  parser_succeeded boolean NOT NULL, parsed_rows integer NOT NULL CHECK (parsed_rows >= 0),
  CHECK ((published_at IS NULL) = (publication_evidence IS NULL)),
  CHECK (state = 'incomplete' OR (body_complete AND header_verified AND parser_succeeded))
);
CREATE INDEX predictive_captures_cutoff_idx ON public.predictive_captures
  (artifact_id, available_at, ingested_at, id) WHERE state = 'published';
```

## 4. Identity

```sql
CREATE TABLE public.predictive_teams (
  id text PRIMARY KEY CHECK (id IN ('nfl:team:ARI','nfl:team:ATL', /* … all 32 … */
                                    'nfl:team:LA','nfl:team:LAC', /* … */ 'nfl:team:WAS'))
);
INSERT INTO public.predictive_teams (id) VALUES ... ;   -- the same 32
```

The CHECK lists exactly the 32 IDs, so `nfl:team:LAR` or a 33rd row is refused
even by the owner, and no role is granted INSERT. A DB case asserts parity with
`NFL_TEAM_ABBREVIATIONS`. `predictive_games` (minted UUIDs) is unchanged.
Team aliases, game/player bridges and game relations are observation kinds
(section 5), with ambiguity rules in section 5.3.

## 5. Evidence observations

```sql
CREATE TABLE public.predictive_observations (
  id text PRIMARY KEY,
  kind text NOT NULL,
  profile_id text NOT NULL REFERENCES public.predictive_source_profiles(id),
  source_record_id text NOT NULL DEFAULT '',
  data jsonb NOT NULL CHECK (public.predictive_payload_valid(kind, data) IS TRUE),
  entity_key text NOT NULL CHECK (entity_key = public.predictive_entity_key(kind, data)),
  source_key text NOT NULL CHECK (source_key = entity_key || '|' || profile_id || '|' || source_record_id),
  game_id uuid GENERATED ALWAYS AS ((data->>'gameId')::uuid) STORED REFERENCES public.predictive_games(id),
  player_id text GENERATED ALWAYS AS (data->>'playerId') STORED,
  team_id text GENERATED ALWAYS AS (data->>'teamId') STORED REFERENCES public.predictive_teams(id),
  season integer GENERATED ALWAYS AS ((data->>'season')::integer) STORED,
  season_type text GENERATED ALWAYS AS (data->>'seasonType') STORED,
  predecessor_id text, correction_reason text,
  UNIQUE (id, source_key),
  FOREIGN KEY (predecessor_id, source_key)
    REFERENCES public.predictive_observations(id, source_key) DEFERRABLE INITIALLY DEFERRED,
  CHECK (kind = 'source-row-absent' OR kind = split_part(entity_key, ':', 1)),
  CHECK ((predecessor_id IS NULL) = (correction_reason IS NULL)),
  CHECK (predecessor_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX predictive_obs_no_branch ON public.predictive_observations (predecessor_id)
  WHERE predecessor_id IS NOT NULL;  -- branching inside one source chain is refused at write
-- Indexes: (entity_key), (source_key), (game_id, kind, player_id, team_id),
-- (player_id, kind, season), (team_id, kind, season), as revision 1.
```

The link table `predictive_artifact_observations` is unchanged. The deferred
publication checks are as revision 1, plus the historical rights check (section 2)
and the absence and bridge checks below.

### 5.1 Absence rows carry routing

`source-row-absent` payloads copy the routing fields of the row they replace
(`gameId`, `playerId`, `teamId`, `season`, `seasonType`, whichever the prior kind
has) plus `priorObservationId`, `priorEntityKey`, `coveringCaptureId` and the
scope fields. The deferred check verifies the copied routing fields and
`priorEntityKey` equal the prior row's values, so generated routing columns are
populated and indexed reads find absences.

**Prior head** means the head of the source chain *immediately before* the absence
(the chain excluding the absence itself), as known at the covering capture's
`available_at`. The absence's predecessor must be exactly that row. The coverage
rules are unchanged from revision 1, section 6.

**Reappearance:** a later full capture containing the row again appends a normal
revision of the original kind whose predecessor is the absence. The chain
continues, and the absence stays in history.

### 5.2 Scoped reads include whole source chains

Persistence reads change from "natural key closure per kind" to two phases:

1. **Discover** relevant `source_key`s through routed predicates on *any*
   revision of the chain (game, player, team, season), not only the requested
   kind.
2. **Expand** each discovered `source_key` to every revision whose capture is
   cutoff-visible, including absence heads and corrections whose routing fields
   moved outside the original predicate.

Selection then takes the cutoff head per source chain, followed by the
reconciliation decision per entity key.

### 5.3 Bridge ambiguity (from owner decision Q3)

Deferred checks refuse a bridge revision that would make two active mappings
for one `provider + raw ID`, or two raw IDs of one provider for the same canonical
key over overlapping effective ranges, unless it supersedes the other through its
own source chain. At replay, disagreeing providers for the same canonical entity
resolve as `unresolved` (`identity-bridge-conflict`).

## 6. Decisions

```sql
CREATE TABLE public.predictive_decisions (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('completion','participation','reconciliation','snap-source-compatibility')),
  entity_key text NOT NULL, policy_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('production-research','synthetic-proof')),
  outcome jsonb NOT NULL CHECK (public.predictive_decision_valid(kind, outcome) IS TRUE),
  run_id text NOT NULL REFERENCES public.predictive_ingestion_runs(id),
  decided_at timestamptz NOT NULL,
  predecessor_id text,
  UNIQUE (id, kind, entity_key, policy_id),
  FOREIGN KEY (predecessor_id, kind, entity_key, policy_id)
    REFERENCES public.predictive_decisions(id, kind, entity_key, policy_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX predictive_decisions_no_branch ON public.predictive_decisions (predecessor_id)
  WHERE predecessor_id IS NOT NULL;
CREATE TABLE public.predictive_decision_inputs (
  decision_id text NOT NULL REFERENCES public.predictive_decisions(id),
  observation_id text NOT NULL REFERENCES public.predictive_observations(id),
  role text NOT NULL CHECK (role IN ('marker','evidence','candidate','selected')),
  PRIMARY KEY (decision_id, observation_id)
);
```

Entity keys: `completion:<gameId>`, `participation:<gameId>:<playerId>`,
`reconciliation:<evidence entity key>`. Deferred checks: every input's capture
is published with `available_at` and `ingested_at` ≤ `decided_at`; every input's
entity key matches the decision's entity (for example, completion inputs are
`event-state-marker` rows for that game); `selected` appears exactly once in a
`reconciliation` with result `selected`; `completionObservedAt` equals the
capture time of a `marker` input.

## 7. Outcome labels (bound to their evidence)

```sql
CREATE TABLE public.predictive_outcome_labels (
  id text PRIMARY KEY,
  player_id text NOT NULL, game_id uuid NOT NULL REFERENCES public.predictive_games(id),
  season_type text NOT NULL CHECK (season_type IN ('REG','POST')),
  stat text NOT NULL CHECK (stat IN ('passing_yards','passing_tds','completions','attempts',
    'passing_interceptions','rushing_yards','carries','receiving_yards','receptions')),
  value integer,
  state text NOT NULL CHECK (state IN ('provisional','final','unresolved','excluded')),
  mode text NOT NULL CHECK (mode IN ('production-research','synthetic-proof')),
  policy_id text NOT NULL CHECK (policy_id = 'canonical-label-finalization-v1'),
  label_version integer NOT NULL CHECK (label_version >= 1),
  predecessor_id text REFERENCES public.predictive_outcome_labels(id),
  completion_decision_id text NOT NULL REFERENCES public.predictive_decisions(id),
  participation_decision_id text NOT NULL REFERENCES public.predictive_decisions(id),
  reconciliation_decision_id text REFERENCES public.predictive_decisions(id),
  selected_observation_id text REFERENCES public.predictive_observations(id),
  player_bridge_observation_id text REFERENCES public.predictive_observations(id),
  eligible_final_at timestamptz, post_window_capture_id text REFERENCES public.predictive_captures(id),
  finalized_at timestamptz, created_at timestamptz NOT NULL,
  UNIQUE (player_id, game_id, season_type, stat, label_version),
  CHECK ((label_version = 1) = (predecessor_id IS NULL)),
  CHECK (state <> 'final' OR (value IS NOT NULL AND selected_observation_id IS NOT NULL
         AND reconciliation_decision_id IS NOT NULL AND post_window_capture_id IS NOT NULL
         AND eligible_final_at IS NOT NULL AND finalized_at >= eligible_final_at AND created_at >= finalized_at)),
  CHECK (state NOT IN ('unresolved','excluded') OR value IS NULL)
);
CREATE UNIQUE INDEX predictive_labels_no_branch ON public.predictive_outcome_labels (predecessor_id)
  WHERE predecessor_id IS NOT NULL;
```

Deferred binding checks. Each one has a direct-SQL negative test:

1. The completion decision's entity key is `completion:<game_id>`, its state is
   `completed`, and `eligible_final_at =
   predictive_label_eligible_final_at(coalesce(actualEnd, completionObservedAt))`.
2. The participation decision's entity key is `participation:<game_id>:<player_id>`
   and its state is `offensive-participant`.
3. The reconciliation decision's entity key is
   `reconciliation:player-game-stats:<game_id>:<player_id>`, its result is
   `selected`, and its selected input = `selected_observation_id`.
4. `value = (selected observation data ->> stat)::integer`, and the selected
   observation's season type equals the label's.
5. The post-window capture is `published` with all completeness flags,
   `captured_at >= eligible_final_at`, and its artifact links
   `selected_observation_id` (the evidence was reconfirmed after the window).
6. Every referenced decision's `decided_at`, and every referenced capture's
   `ingested_at`, is ≤ `created_at`.
7. Versions: a predecessor has the same natural key, `label_version` one lower and
   an earlier `created_at`. Version 1 has no predecessor (CHECK above). There's no
   branching (unique predecessor).
8. Mode: `synthetic-proof` if any bound evidence is synthetic (section 2).

## 8. Feature runs (saved, with an explicit write path)

```sql
CREATE TABLE public.predictive_feature_runs (
  id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('production-research','synthetic-proof')),
  feature_version text NOT NULL, candidate text NOT NULL,
  player_id text NOT NULL, game_id uuid NOT NULL REFERENCES public.predictive_games(id),
  cutoff timestamptz NOT NULL, computed_at timestamptz NOT NULL CHECK (computed_at >= cutoff),
  recorded_at timestamptz NOT NULL CHECK (recorded_at >= computed_at),
  code_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready-inputs','unavailable-inputs')),
  reasons text[] NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  execution_digest text NOT NULL CHECK (execution_digest ~ '^[a-f0-9]{64}$'),
  bundle_blob_sha256 text NOT NULL REFERENCES public.predictive_blobs(sha256)
);
CREATE TABLE public.predictive_feature_run_dependencies (
  feature_run_id text NOT NULL REFERENCES public.predictive_feature_runs(id),
  observation_id text REFERENCES public.predictive_observations(id),
  decision_id text REFERENCES public.predictive_decisions(id),
  rights_decision_id text REFERENCES public.predictive_rights_decisions(id),
  policy_id text, feature_definition_id text,
  CHECK (num_nonnulls(observation_id, decision_id, rights_decision_id, policy_id, feature_definition_id) = 1)
);
CREATE UNIQUE INDEX predictive_frd_unique ON public.predictive_feature_run_dependencies
  (feature_run_id, coalesce(observation_id, decision_id, rights_decision_id, policy_id, feature_definition_id));
CREATE TABLE public.predictive_feature_run_pins (
  id text PRIMARY KEY, feature_run_id text NOT NULL REFERENCES public.predictive_feature_runs(id),
  reason text NOT NULL CHECK (reason IN ('training','serving','evaluation','owner')), pinned_at timestamptz NOT NULL
);
CREATE TABLE public.predictive_feature_run_unpins (     -- append-only unpin events
  pin_id text PRIMARY KEY REFERENCES public.predictive_feature_run_pins(id), unpinned_at timestamptz NOT NULL
);
```

**Write path:**

1. **Compute:** in the existing `REPEATABLE READ READ ONLY` transaction as
   `predictive_replay`, assemble the bundle and its exact dependency list from that
   one snapshot.
2. **Record:** in a separate short transaction as `predictive_recorder` (INSERT on
   the feature-run tables and blobs only, no SELECT on evidence beyond the FK
   checks), write the bundle blob, the run row and every dependency atomically.
   **No reread or reselection.**
3. **Failure:** if recording fails, the API returns
   `{ status: "unavailable", reason: "feature-run-not-recorded" }`. A computed but
   unsaved bundle is never returned as a success.

Deferred completeness checks: every observation and decision dependency is
cutoff-visible (`available_at` and `ingested_at` ≤ `cutoff`); every decision's
inputs are also listed (transitive closure); there's a `model-input` rights
decision in force at `computed_at` (current access, section 2) for every
profile; and the mode is consistent.

**Digests** (canonical JSON, the existing `canonical()` recipe: sorted keys, no
whitespace):

- `input_digest` hashes the **cutoff-time inputs**: the request minus `computedAt`,
  feature version, selected values and summaries, and observation/decision
  dependency IDs with their capture times. It stays identical when recomputed
  later, and is unaffected by rights changes.
- `execution_digest` hashes the **whole execution record**: `input_digest` plus
  rights decision IDs, policy and definition IDs, code version, `computed_at`
  and `recorded_at`.

**Retention (`feature-run-retention-v1`):** a run with no active pin (no pin, or
every pin has an unpin event) expires 90 days after `recorded_at`, through a
normal `expiry` retention event. Saved bundles are always in scope of provider
deletions, pinned or not.

## 9. Retention and deletion

```sql
CREATE TABLE public.predictive_retention_events (
  id text PRIMARY KEY,
  reason text NOT NULL CHECK (reason IN ('expiry','rights-revoked','provider-request','owner-request')),
  authority text NOT NULL, decided_at timestamptz NOT NULL,
  scope_descriptor jsonb NOT NULL,   -- deterministic: profile_ids, capture time range, dataset/scope fields
  audit_level text NOT NULL CHECK (audit_level IN ('full','digest-only')),
  removed_counts jsonb,               -- per target kind, filled when executed
  removed_ids_digest text CHECK (removed_ids_digest ~ '^[a-f0-9]{64}$'),
  executed_at timestamptz
);
CREATE TABLE public.predictive_retention_tombstones (   -- only when audit_level = 'full'
  retention_event_id text NOT NULL REFERENCES public.predictive_retention_events(id),
  target_kind text NOT NULL, target_id text NOT NULL, PRIMARY KEY (target_kind, target_id)
);
CREATE TABLE public.predictive_retention_authorizations (  -- control state, NOT append-only
  txid xid8 PRIMARY KEY, retention_event_id text NOT NULL REFERENCES public.predictive_retention_events(id)
);
```

- **Scoped row deletion is the rule** for provider-required removal: blob bytes and
  every derived row are deleted. Retention events are the only row in this table
  set that is ever updated (`executed_at`, `removed_counts`, digest), and only by
  the function.
- **Deletion closure**, computed by `predictive_retention_execute(event_id)` in one
  transaction, in dependency order:
  1. observations in scope, plus **every descendant in their source chains**
     (corrections and absences);
  2. their artifact links, then artifacts in scope;
  3. decisions with any deleted input, plus their descendants;
  4. labels referencing any deleted decision or observation, plus later versions;
  5. feature runs depending on any of the above, with their dependencies, pins and
     unpins;
  6. blobs whose every referencing artifact (and feature-run bundle) was deleted.
     A blob still referenced outside the scope is kept.

  Ordinary FKs stay (no `CASCADE`). If the computed closure is incomplete, the FKs
  fail the transaction, which is the safety check.
- **Audit:** `full` keeps tombstones (target kind + ID, no payload). For
  `digest-only`, used where the provider forbids keeping identifiers, tombstones
  aren't written; only counts, the digest and the **deterministic scope
  descriptor** are kept. The descriptor is what lets the same deletion be
  re-applied to a backup.
- **Backups:** a restored backup re-applies every later retention event (by scope
  descriptor) before any read. If a provider forbids even the scope descriptor,
  every backup containing that profile's data must be destroyed, and that's
  recorded as the event's authority.
- **Blob files** are removed from the artifact store by the owner CLI after the
  transaction commits. The CLI refuses to remove a blob the database still
  references.

## 10. Roles and privileges

| Role | Granted |
| --- | --- |
| `predictive_ingest` | INSERT on profiles, rights, runs, run rights, blobs, artifacts, captures, observations, links, decisions, decision inputs, labels; SELECT on those |
| `predictive_replay` | SELECT only, used inside READ ONLY transactions |
| `predictive_recorder` | INSERT on blobs, feature runs, dependencies, pins, unpins; SELECT where FK checks need it |
| `predictive_retention_owner` | EXECUTE on scoped retention, cleanup and history APIs only; no table grants |
| `predictive_harness` | Disposable harness only; the membership that permits `synthetic-proof` rows |

- **Every function:** `REVOKE ALL ON FUNCTION ... FROM PUBLIC`, then grant only to
  the intended role. Validators and key builders are granted to ingest, replay
  and recorder.
- **`predictive_retention_execute`:** `SECURITY DEFINER`,
  `SET search_path = pg_catalog, pg_temp` (`pg_temp` last), every reference
  schema-qualified. Its first statement checks
  `pg_has_role(session_user, 'predictive_retention_owner', 'MEMBER')`.
- **The append-only exception** is a row in `predictive_retention_authorizations`
  for the current `pg_current_xact_id()`. Only the definer function can insert it,
  because no role has INSERT. There is no settable flag, so `SET predictive.*`
  spoofing does nothing.
- **No role has UPDATE, DELETE or TRUNCATE** on any table; the append-only triggers
  stay as the second layer.
- **The catalog collector does not record ACLs.** Privilege guarantees are proven
  by explicit DB cases run under `SET ROLE` as each real role, not by catalog
  contracts.
- Grants apply when the roles exist. The disposable harness creates them, and
  Production role setup stays behind #95.

## 11. Per-kind validators and keys

As revision 1, section 9, with these changes:

- `event-state-marker` key `event-state-marker:<gameId>:<markerType>`;
  `participation-evidence` key
  `participation-evidence:<gameId>:<playerId>:<evidenceKind>`.
- `source-row-absent`: the key is `priorEntityKey`, and the payload carries the
  copied routing fields (5.1).
- Bridge kinds are keyed by provider + raw ID (the documented exception, section 1).
- **No evidence kinds yet** for play-by-play game-script aggregates, forecasts,
  surface or altitude. The §7b candidate features are **reserved** (feature IDs
  defined, always `unavailable-inputs` / `<feature>-source-unqualified`). Their
  evidence contracts are deferred, and **adding them will need a later additive
  migration** once 0003 is frozen.

## 12. Migration reset and regeneration procedure

The generator refuses edited checksums for registered migrations; that guard is
not changed. During PR A's draft period (0003 never applied outside disposable
databases), **every edit to `0003_predictive_evidence.sql`** follows:

1. `git show origin/main:db/migration-manifest.json > db/migration-manifest.json`
   (the recorded v2 state);
2. remove `db/catalog-contracts/0003.json`;
3. `npm run db:migrations:generate`, `npm run db:contracts:generate`,
   `npm run db:readiness:generate`;
4. `npm run test:db:down`, then recreate disposable databases through
   `npm run test:db:local`.

The commit message names the reset. **0003 is frozen** when PR A passes review;
after that, any change is a new forward migration. Old synthetic v3/v4 artifacts
are removed in step 2, and `docs/database-migrations.md` records the reset and
the recreate requirement.

## 13. PR A test list

Revision 1's list, with these changes and additions:

- **Replaces** the mandatory case "predictive v3 team identity upgrade preserves
  replay and refuses unqualified legacy Rams rows" (in the test file and in
  `db-test-contract.mjs`) with:
  1. the 32 seeded IDs equal `NFL_TEAM_ABBREVIATIONS`, and a Rams dataset publishes
     and replays;
  2. `nfl:team:LAR`, an arbitrary team ID, and any INSERT into `predictive_teams`
     are refused;
  3. a v2 → new v3 upgrade preserves existing v1/v2 data and readiness;
  4. a database whose ledger records the old synthetic 0003/0004 checksums is
     refused by the runner, unrepaired.
- **Rights:** a decision recorded after a run, with a backdated effective date,
  doesn't authorize it; a predecessor from another profile is refused; a branching
  chain is refused; current access is blocked by a later revocation; a trial
  profile never satisfies `model-input`; synthetic rows are refused for non-harness
  sessions.
- **Privileges** (as real roles via `SET ROLE`): ingest and replay can't execute
  retention; `SET predictive.*` spoofing has no effect; an INSERT into the
  authorizations table is refused; replay can't INSERT; PUBLIC has no EXECUTE on
  any predictive function.
- **Absence:** the present → absent → present lifecycle; a routed read finds the
  absence head; a correction that moves routing outside the indexed scope is still
  expanded; "prior head" excludes the absence itself.
- **Labels:** one negative test per binding check (7.1–7.8).
- **Feature runs:** the recorder path saves atomically; a failed record returns
  `feature-run-not-recorded`; a missing bundle, an unresolvable dependency, a
  missing transitive input or a post-cutoff dependency is refused; `input_digest`
  is stable under a rights change while `execution_digest` changes.
- **Retention:** chain descendants and derived rows are deleted; a shared blob is
  kept; an incomplete closure fails on the FKs; `digest-only` keeps no IDs; a
  restored backup re-applies the scope descriptor; unpin events expire runs.

## 14. Step 2 implementation notes (2026-10-10)

Step 2 of PR A implements the parts of this DDL the adapted passing-yards proof
needs. Each later step regenerates migration 0003 using the section 12 procedure.

**Built in step 2:**
- helpers and per-kind validators
- source profiles, with an added `evidence_kinds` column limiting which kinds
  a profile may emit
- rights decisions, with `predictive_rights_in_force` returning the decision
  ID and `predictive_rights_allow`
- blobs (`storage_ref` is `sha256.json` or `sha256.csv` by media type) and
  artifacts with scope fields
- runs, run rights, and captures with completeness
- the 32 seeded teams, and games
- observations with entity and source keys, the no-branch index and
  source-chain foreign key
- artifact links, append-only triggers, and deferred publication checks
  (historical rights, run rights recorded, kind allowed by profile,
  `full` retrieval only, correction timing, cycles)
- `predictive_harness_session()`
- `REVOKE … FROM PUBLIC` on every function, with conditional grants to
  `predictive_ingest` and `predictive_replay`

**Deferred to steps 3–10, as planned:**
- the persisted decisions table and decision inputs. Step 2 computes
  completion (`event-completion-v1`) and participation (`participation-v1`) at
  replay from cutoff-visible evidence, with the same rules.
- outcome labels; feature runs, pins and unpins
- snap kinds, bridge kinds and `source-row-absent`
- retention, and the recorder and retention-owner roles

**Payload refinements to section 11, made during implementation:**
- `schedule` stores `rawGameday`, `rawGametime`, `rawRoof`, `rawSurface` and
  `rawStadiumId`, each nullable. The Eastern conversion is always
  `America/New_York` and is round-trip checked in code; SQL checks formats.
- `membership` keeps `effectiveFrom` and `effectiveTo`, which the former-team
  gap rule needs, and adds `rosterStatus`, `season`, `seasonType` and `week`.
- Player and team game stats carry all ten counts plus a `missing` object
  mapping each null field to `source-blank` or `source-missing`. A non-null
  value may not have a missing reason.
- `participation-evidence` stores `participation-feed`,
  `official-inactive-list` and `provider-snap-count` claims. Positive usage is
  derived from the stats row by `participation-v1` and is not stored separately.
- `availability` stores raw report/practice status and depth rank.
  `availability-v1` withholds only on an explicit `Out` report; blank or missing
  reports stay unknown.
- Entity keys: `event-state-marker:<gameId>:<markerType>` and
  `participation-evidence:<gameId>:<playerId>:<evidenceKind>`.

**Validation (2026-10-10, Node 24.21.0, PostgreSQL 18.6):**
- typecheck and lint
- 831 jsdom + 385 Node tests, including 193 pure predictive, storage and source
  tests
- the full disposable DB suite: 74 Node + 32 Vitest cases, with all 15
  mandatory predictive cases, 13 lease cases, 4 readiness cases and catalog
  contracts verified
- the CI gate and DB guards

### Step 4 additions (2026-10-10)

- **`predictive_decisions` and `predictive_decision_inputs`,** with
  `predictive_decision_valid` and the deferred `predictive_decision_check`.
  Only `reconciliation-v1` outcomes are accepted so far; completion,
  participation and snap-compatibility outcomes stay refused until their steps.
- **Reconciliation rules:**
  - A decision's inputs must be distinct provider heads for one fact, each usable
    by `decided_at`.
  - `single-source` or `sources-agree` selects one input.
  - `material-discrepancy` records a conflict and selects nothing.
  - Any synthetic input forces `synthetic-proof` mode, which needs the harness
    role. Chains can't branch.
- **Replay:**
  - A decision resolves a fact only when its inputs exactly equal the current
    provider heads and it was decided by the cutoff.
  - A later correction or a new provider makes it stale, and the fact goes back
    to ambiguous.
  - Bundles list the decisions they used in `reconciliations`.
- **Fix:** persisted replay checks current-access rights against the database
  clock (`now()`), never the caller's `computedAt`. An old computation time can no
  longer bypass a later revocation, and a DB case proves it.

### Step 5 additions (2026-10-10)

- **The `source-row-absent` evidence kind** (`absence-v1`):
  - Payload: the fixed fields from section 6, plus exactly the routing fields
    (`gameId`, `playerId`, `teamId`, `season`, `seasonType`) copied from the row
    it replaces.
  - Its entity key is `priorEntityKey`, it shares the prior row's source key, and
    its predecessor is the prior row.
- **Acceptance (`predictive_absence_valid` and the matching code validator):**
  - a complete, published, `full` capture of the same profile and filter covers
    the prior row's scope (the same file, or a strictly broader one; manual scopes
    cover nothing)
  - the covering capture no longer links that source chain
  - times run prior capture ≤ covering capture ≤ absence capture
- **Replay:**
  - From the absence's availability onward, a fact whose provider chain ends in
    an absence returns `absent`, and the bundle gains
    `required-input-disappeared`. Earlier cutoffs are unchanged.
  - A later reappearance is a normal revision whose predecessor is the absence.
- **Still deferred to PR B:** automatically detecting absences from real file
  recaptures. Step 5 supplies the contract and its enforcement; tests construct
  absences directly.

### Step 6 additions (2026-10-10)

- **Completion decisions:** `kind = 'completion'`, policy `event-completion-v1`,
  entity key `completion:<gameId>`, outcome
  `{ state, completionObservedAt, actualEnd: null }`, inputs with role `marker`.
  `actualEnd` stays null until an actual-end source is qualified.
- **No cherry-picking:** a record's inputs must equal exactly the marker heads
  for that game usable at `decided_at`, absences included. The database
  recomputes the state and observed time from them (`predictive_decision_check`,
  matching `completion.ts`). A disappeared or multi-provider marker is
  `conflicting`.
- **Replay** recomputes `event-completion-v1` from the cutoff-visible heads and
  cites (`completions`) the latest record only when it judged exactly those heads
  and reached the same outcome. A stale record is never trusted. Persisted
  completion records become mandatory for outcome labels in step 7.
- **Design choice:** the policy is deterministic and versioned, so evidence plus
  policy is the source of truth, and a record is a database-verified,
  citable application of it. That avoids two sources of truth and avoids
  requiring a fresh record after every marker capture.

### Step 7 additions (2026-10-10)

- **Participation decisions** (`participation-v1`, `participation:<gameId>:<playerId>`):
  - Inputs (role `evidence`) are exactly the participation-evidence heads plus the
    player-stats heads usable at `decided_at`. The database recomputes the state.
  - Positive usage counts only when **every** stats head is present and shows an
    attempt, carry or target.
  - Several provider heads for one evidence kind, or evidence that disappeared,
    is `conflicting`.
  - Replay recomputes the state and cites a matching record (`participations`).
- **`predictive_decision_current(decision, t)`:** a decision's inputs equal the
  heads of its evidence scope usable at `t`. It's used for completion and
  participation decisions at their own `decided_at`, and by labels at
  `created_at`, so a label can never rely on a decision that later evidence has
  overtaken.
- **`predictive_outcome_labels`** (`canonical-label-finalization-v1`), with a
  deferred check whose failures are named `predictive-label-binding-1` to `-8`
  (code mirror: `labels.ts`):
  1. The completion decision is for this game and current.
  2. The participation decision is for this player-game and current;
     provisional/final labels need `completed` and `offensive-participant`, and
     excluded labels need a confirmed non-participant.
  3. A selected, current reconciliation of this player-game's stats names the
     selected observation.
  4. The value equals the selected payload field for the season type, and the
     observation was usable by `created_at`. Unresolved and excluded labels have
     no value.
  5. Final labels: `eligible_final_at` = the later of bound + 72h and the first
     Thursday 12:00 UTC strictly after the bound
     (`predictive_label_eligible_final_at`); `finalized_at` ≥ eligible;
     `created_at` ≥ finalized; and a complete published post-window capture,
     captured at or after eligible, that relinks the selected observation.
  6. The post-window capture was ingested by `created_at`, and the run is
     published.
  7. The version chain has the same natural key, version + 1, an earlier
     predecessor and no branching.
  8. The mode is consistent with synthetic evidence; synthetic-proof labels need
     the harness role.
- **Publication** refuses labels created after the publish time.

### Step 8 additions (2026-10-10)

- **Tables:** `predictive_feature_runs`, `predictive_feature_run_dependencies`
  (exactly one of observation, decision, rights decision, policy or feature
  definition per row), `predictive_feature_run_pins`, and append-only
  `predictive_feature_run_unpins` (an unpin can't precede its pin; one per pin).
- **Write path (`replayAndRecord`):**
  - Compute in the read-only repeatable-read snapshot.
  - Then, in a separate transaction as `predictive_recorder`, write the canonical
    bundle blob, the run and its full manifest, without rereading evidence.
  - Any failure returns `{ status: "unavailable", reason: "feature-run-not-recorded" }`.
- **Digests (`featureRuns.ts`):** `input_digest` is the bundle's cutoff-time
  digest. `execution_digest` also binds the rights decisions in force, policies,
  code version and both times. The run ID is `feature-run:<execution_digest>`.
- **Deferred run-level check** (`predictive_feature_run_check`):
  - every observation dependency was usable at the cutoff, and every decision was
    both decided by and still current at it
  - every cited decision's inputs are listed
  - the feature definition is named
  - a ready run lists a model-input rights decision in force at `recorded_at` for
    every evidence profile
  - the mode follows the evidence
- **Sealing:** a dependency for a run created in an earlier transaction is refused
  (`predictive-feature-run-sealed`), so the run-level check covers the whole
  manifest at commit time. That also replaced a per-row check that took about 27
  seconds on one case.
- **Retention:** `predictive_feature_run_expired(run, t)`, under
  `feature-run-retention-v1`, is true 90 days after recording unless a pin is
  active at `t`. Deleting expired runs is part of step 10's retention operation.
- **Roles:** `predictive_recorder` can read evidence for the checks and can write
  only blobs and feature-run tables. `predictive_replay` can read feature runs.
- **Known nuance:** `decided_at` on rights and decisions is an *asserted*
  knowledge time. A decision inserted later with an earlier `decided_at` changes
  what "known by t" evaluates to for earlier instants. Publication refuses future
  times, but not backdating. PR B's real ingestion should stamp knowledge times
  from the database clock, as current access already does.

### Step 9 additions (2026-10-10)

- **Kinds (`bridge-v1`):** `team-alias` (`provider`, `rawAlias`, `teamId`,
  effective seasons), `game-bridge` (`provider`, `rawGameId`, `gameId`),
  `player-bridge` (`provider`, `rawPlayerId`, `playerId`, effective instants) and
  `game-relation` (`gameId`, `predecessorGameId`, `relation = 'replacement'`).
  Bridges are evidence, so rights, captures, chains and replay apply to them as to
  any other observation. Profiles may now declare up to 13 evidence kinds.
- **Entity keys:** `team-alias:<provider>:<raw>`, `game-bridge:<provider>:<raw>`,
  `player-bridge:<provider>:<raw>` and `game-relation:<gameId>`. Provider names
  match `^[a-z0-9][a-z0-9-]{0,31}$`, raw identifiers `^[A-Za-z0-9._-]{1,64}$`.
  The generic game-ID check now applies to any payload that carries `gameId`.
- **Strict ambiguity at write:** within one source profile and provider, the
  publication check raises `predictive-bridge-ambiguous` when two current heads
  map different raw IDs to one game, or to one player over overlapping effective
  windows. Team aliases may be many-to-one. A correction in the same chain is
  accepted. Mirrored by `validateBridges`.
- **Cross-source disagreement at replay:** `resolvePlayer`, `resolveTeam`,
  `resolveGame` and `replacementOf` return `identity-bridge-missing` or
  `identity-bridge-conflict` rather than picking a mapping.
- **Games:** publishing a `game-relation` also inserts its predecessor game.

### Step 10 additions (2026-10-10)

- **Tables:** `predictive_retention_events`, `predictive_retention_tombstones`
  and `predictive_retention_authorizations`, plus
  `predictive_retention_scope_valid(reason, scope)`.
- **Scope descriptors** (deterministic, validated in SQL):
  - `{ kind: "source", profileIds, capturedFrom, capturedBefore }`:
    `profileIds` is sorted, unique and registered, and the half-open capture
    range may be open at either end. Used for `rights-revoked`,
    `provider-request` and `owner-request`.
  - `{ kind: "feature-run-expiry", asOf }`: used only for `expiry`.
    `decided_at` and `asOf` can't be in the future.
- **`predictive_retention_execute(...)`:**
  - `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`, every reference
    schema-qualified.
  - Its first statement checks `pg_has_role(session_user,
    'predictive_retention_owner', 'MEMBER')`.
  - Revoked from PUBLIC and granted only to `predictive_retention_owner`, which
    holds no table privilege.
  - It computes the section 9 closure and deletes it in dependency order. An
    artifact with any capture in range is removed whole, bytes and captures.
- **Refinements to section 9:**
  - **Event rows** are written once, complete with counts, digest and
    `executed_at`, so no audit row is ever updated.
  - **Tombstone key** is `(event, target kind, target ID)`.
  - **Authorizations** carry no foreign key. The row is inserted and removed
    inside the function, so nothing after it in the transaction is authorized.
- **Append-only exception:** `predictive_append_only()` allows a DELETE only
  while the current `pg_current_xact_id()` holds an authorization row. Audit
  tables use their own always-refusing trigger. A custom `SET predictive.*`
  authorizes nothing.
- **Audit:**
  - `removed_ids_digest` is the SHA-256 of the sorted `kind:id` lines.
  - `full` keeps tombstones of exactly those lines; `digest-only` keeps none.
  - Removed blob references are returned to the caller and never stored.
- **Owner path (`store.retain`):**
  - Executes as the owner role in one transaction.
  - After commit, removes each returned blob file through
    `ArtifactStore.remove`, skipping any blob a row references again.
- **Backups:**
  - `store.retentionEvents()` exports the recorded events.
  - `store.reapply(events)` re-executes every missing event, oldest first, by
    its descriptor and reports `matched`. `matched` is false when the restored
    backup lacked rows the original removal saw.
- **Replay:**
  - A source event whose range starts at or before the cutoff marks its
    profiles.
  - A bundle that is already unavailable, or that still reads a marked
    profile, gets `retained-evidence-removed`. Removed evidence is never
    silently replaced by an older head.
- **Harness note:** the disposable harness session is a superuser, so the
  `pg_has_role` check always passes there. Role grants are what the DB cases
  prove. Production role setup stays behind #95.

### Review fix 1 (2026-10-10)

- Reconciliation decisions must cite the complete set of provider heads for
  their fact visible at `decided_at`, matching completion and participation.
  SQL uses `predictive_decision_current`; TypeScript computes the same
  cutoff-visible head set.
- Publication loads every stored source chain in each decision's evidence scope
  before validation. Loading only the cited IDs would let an omitted provider
  head evade the code validator even though PostgreSQL could see it.

### Review fix 6 (2026-10-10)

- Persisted replay loads participation decisions for every player-game in the
  requested player's evidence scope. Replay cites only records that bind the
  current participation inputs, and saved feature runs retain those decision
  IDs.

### Review fix 7 (2026-10-10)

- Feature-run manifests now require every cited decision to remain current at
  the feature cutoff. A later correction cannot leave a run bound to a stale
  decision and its superseded inputs.

### Review fix 3 (2026-10-10)

- **Typed game scope:** artifacts gain `scope_game_id` (FK to
  games), and absence payloads gain `scopeGameId`. Season is required for
  season-file, week-file and game scopes, week for week-file, and the game ID
  for game scope, in SQL and TypeScript. Game coverage now compares the exact
  game, so an unrelated game's empty capture can no longer prove an absence.
  Persistence registers a game-scoped artifact's game before inserting it. The
  archive journal moves to `formatVersion` 3 and refuses version 2.

### Review fix 8 (2026-10-10)

- **Unambiguous retention digest:** `removed_ids_digest` is now the SHA-256 of the
  canonical JSON array of `{"id","kind"}` pairs ordered by kind then ID (C
  collation), built with JSON escaping. `retentionIdsDigest()` in
  `persistence.ts` mirrors it. Before this, `kind:id` lines joined by newlines
  could serialize two different ID sets identically.
- **No control characters in IDs:** every text primary key in 0003 refuses
  `\x01-\x1f` and `\x7f`, and TypeScript identity validation refuses the same
  set.
- The function builds the removed set in parallel arrays, never a temp table,
  because a caller could pre-create a `pg_temp` relation that the definer
  function would then use.

### Review fix 9 (2026-10-10)

- **Snap kinds:**
  - `player-game-snaps`: offense and special-teams snaps, `played`/`started`
    flags, optional routes.
  - `team-game-snaps`: offense snaps, optional dropbacks, and the provider's
    `playCountingDefinition`.
  - Validated by `predictive_snaps_valid` and `validateSnaps`: counts 0–300,
    flags boolean, a missing reason for exactly the null fields, and blanks
    never zero-filled.
  - Entity keys follow the stats kinds; profiles may declare up to 15 kinds.
- **`snap-source-compatibility` (`snap-compatibility-v1`, `snaps.ts`):**
  - The entity key names both profiles in sorted order. The inputs must be
    exactly the overlap: every snap head (player, team and absences) of both
    profiles in each game both cover with a team snap head at `decided_at`.
    The caller can't leave out disagreeing games.
  - `compatible` requires exactly one present head per profile per fact,
    equal offense snaps, and the same play-counting definition.
    `insufficient-overlap` means no shared game.
  - `predictive_decision_current` supports the kind, so labels, feature runs
    and staleness checks treat it like the other decisions.
- **`snapShare`** (pure, for the first enriched rushing/receiving builder):
  - Pooled player offense snaps over paired team offense snaps across the same
    eligible games.
  - A missing pair, a blank, a player count above the team's, a mismatched
    game or team, a zero denominator, or providers without a current
    compatibility decision all leave the ratio undefined, with a reason.
  - The cross-row rule "player offense snaps ≤ team offense snaps" is enforced
    here at pairing time, not at publication.
- Source acquisition and qualification stay in PR B. Being able to store snaps
  doesn't qualify any source.

### Review fix 5 (2026-10-10)

- **Identity links:** a new append-only `predictive_profile_identity_links`
  table (`stats_profile_id`, `bridge_profile_id`, `provider`, `decided_at`),
  registered through the dataset's `identityLinks`. A link explicitly lets one
  profile's player bridges in one provider namespace resolve another profile's
  stats identities. Roster and statistics feeds can be different profiles, and
  profile equality is never assumed.
- **Labels:** gain `player_bridge_observation_id`. It is required for `final`,
  optional for `provisional`, and absent for `unresolved`/`excluded` (table
  CHECKs).
- **Binding check 9** (`predictive_label_check`, `labels.ts`): the pinned
  bridge revision must:
  - be a `player-bridge` for the label's player;
  - be usable at creation;
  - still be its chain's head at creation, so a later correction requires a
    new label version;
  - be linked (by creation time) to the selected stats row's profile for its
    provider;
  - be unambiguous at creation: no other current head in that provider maps
    the same raw ID to another player, or the same player from another raw ID
    with an overlapping window;
  - have a window containing every current schedule head's kickoff.

  GSIS-native data uses roster-backed bridges whose raw ID is the GSIS ID. That
  establishes provenance and identity coverage, not independent statistical
  reconciliation.
- **Mode and retention:** a synthetic bridge makes the label `synthetic-proof`.
  Retention deletes labels that cite a deleted bridge.
- `predictive_observation_usable(id, t)` is a shared helper using positional
  parameters, because a column name would shadow a same-named parameter in a
  SQL function.

### Review fix 2 (2026-10-10)

- **`predictive_record_feature_run(run, dependencies)`** is the only way to
  save a feature run.
  - `SECURITY DEFINER` with `search_path = pg_catalog, pg_temp`. It checks
    membership of `predictive_recorder` and is executable only by that role.
  - It creates the run and its complete manifest in one call.
  - `predictive_recorder` lost INSERT on `predictive_feature_runs` and
    `predictive_feature_run_dependencies`; pins, unpins and blobs are
    unchanged.
- **Clock and rights:**
  - The function takes every evidence profile's advisory lock (namespace
    520053, keyed by profile, in sorted order). `predictive_rights_check()`
    takes the same lock for each rights insert.
  - It then reads `date_trunc('milliseconds', clock_timestamp())` once, for
    `recorded_at`, and recomputes the rights in force at that instant. The
    caller supplies neither.
  - `now()` would be the transaction's start time, so a delayed transaction
    could otherwise keep an earlier time.
  - It refuses anything but READ COMMITTED (`predictive-recorder-isolation-refused`),
    because an older snapshot could miss a revocation that committed while it
    waited.
  - The deferred run-level check still runs at commit against the stamped
    time.
- **Execution digest:** SHA-256 over `\x1f`-separated fields, list items
  `\x1e`-separated, computed in SQL. `executionDigest()` in `featureRuns.ts`
  mirrors it, and `replayAndRecord` refuses a server result that doesn't
  match.
- **Proofs:**
  - direct INSERTs are refused for the recorder;
  - `recorded_at` is the database clock;
  - REPEATABLE READ is refused;
  - a recording blocked behind an uncommitted revocation waits on the profile
    lock, sees the revocation, and is refused at commit.

### Review fix 4 (2026-10-10)

- **Per-digest session locks** (advisory namespace 520054, keyed by each
  digest's first 32 bits) coordinate artifact-store files with blob rows:
  - **Publication** holds a lock for every artifact digest from before writing
    the files until its transaction commits. **Refusal diagnostics** do the
    same.
  - **Feature-run recording** holds its bundle digest's lock the same way.
  - **Cleanup** holds the lock from the database reference recheck through the
    unlink.
  - Locks are taken in ascending key order on the store's own connection, with
    a 5-second `lock_timeout`, and released in `finally`.
  - A lost connection drops the locks and fails the recheck query, so no
    unlink runs without the lock.
- **`predictive_blob_removals`** is a control-state queue with no grants,
  filled by `predictive_retention_execute`.
  - `removeQueuedBlob` keeps the file when the blob is referenced again, and
    otherwise unlinks it. Either way, the queue row is deleted only after that
    step.
  - A crash or failed unlink leaves the row, and `store.resumeBlobRemovals()`
    retries.
  - The second implementation review separates database blobs from journals and
    adds orphan recovery, as recorded below.
  - For digest-only events, the queue briefly holds the blob reference until
    its file is removed.
- **Proofs:**
  - Cleanup waits behind a publisher holding the lock, then keeps the file the
    publisher re-referenced.
  - A publisher waits behind cleanup mid-unlink, then rewrites the file for its
    committed row.
  - A failed unlink is resumed after the event has committed.
- Each artifact root belongs to one authoritative database.

### Second implementation review fixes (2026-10-11)

- **Execute-only cleanup:** `predictive_pending_blob_removals()`,
  `predictive_blob_referenced(text)`, `predictive_ack_blob_removal(text)` and
  `predictive_retention_history()` use `SECURITY DEFINER`, qualified references,
  fixed `pg_catalog, pg_temp` search paths and session-user membership checks.
  PUBLIC has no execution grant. Retention still has no table privileges.
  Reference rechecks and acknowledgements require the session's digest advisory
  lock and READ COMMITTED isolation. Queue listing returns at most 1,024 entries;
  resume handles one batch, so the owner repeats until empty. Ingest and recorder
  may execute only the reference recheck needed for rollback cleanup.
- **Blob lifecycle:** `.db-blobs/` owns SQL-managed bytes; existing private
  archive/journal files stay at the registered root for compatibility. Root and
  database-directory registration are checked and synced before publication.
  Publication, diagnostic recording and feature-run recording remove unreferenced
  files after rollback while still holding the digest lock. Temporary write
  failures also attempt unlink. Crashes or cleanup failures are recovered by
  `store.sweepOrphanBlobs()` with a database-clock age cutoff (24 hours by default,
  configurable from one hour to 30 days). The sweep checks age and committed
  references under the digest lock and only scans private digest files and
  digest-tagged temporary files in `.db-blobs/`. Committed final bytes, recent
  files and all journals are preserved. Aged temporary files are removable even
  for a committed digest; they are never SQL references. The owner handles journal and backup retention
  separately. One authoritative database owns each root, and all writers must
  cooperate with the lock protocol on dedicated sequential sessions.
- **Exact player identity:** membership, player stats, player snaps,
  participation evidence and availability require `rawPlayerId` and
  `playerIdProvider`. The latter names the ID namespace (for example `gsis`),
  rather than necessarily the feed distributor. Label binding check 9 compares
  the selected stats row's raw ID and namespace to its pinned bridge, and its
  canonical player to the label. Profile authorization remains an additional
  check. GSIS-native data keeps its GSIS ID as the exact raw identity.
- **Bridge ambiguity:** within one profile/provider, raw ID → different
  canonical IDs and different raw IDs → one canonical ID are both rejected for
  player/game bridges. Player effective ranges and revision knowledge ranges
  must overlap for a conflict. A predecessor ends when its successor becomes
  known; later corrections cannot hide an earlier conflict. Team aliases retain
  their approved many-to-one behavior.
- **Independent regressions:** a non-superuser login with retention membership
  only completes retention and queue recovery while direct table access fails.
  Rollback failures cover publication, diagnostics and feature runs; aged orphan
  final/temp files are removed while committed, recent and journal bytes survive.
  TypeScript and direct SQL reject both bridge ambiguity directions and
  historical conflicts hidden by later corrections. The raw-X/bridge-Y label
  scenario fails check 9. Removing a cited bridge deletes its final label and a
  later label citing a different surviving bridge, while preserving the earlier
  unbridged provisional label.
- **Draft reset:** only unmerged 0003 and its generated artifacts change. Released
  v1/v2 files/contracts and readiness minimum 2 remain intact. Only disposable
  PostgreSQL is used; hosted roles and migrations remain gated by #95.

### Cleanup review follow-up (2026-10-11)

- Orphan candidates distinguish final and temporary filenames. The sweep removes
  aged temporary files under the digest lock even when final bytes remain
  committed. Both kinds recheck filesystem age after acquiring the lock.
- The filesystem now matches SQL's media contract: `application/json` maps to
  `<sha>.json` and `text/csv` maps to `<sha>.csv`. Read/remove validate either
  exact address; orphan discovery includes CSV finals. The write API defaults to
  JSON for existing archive/publication callers. No SQL or migration artifact
  changes are needed, and real-source parser qualification remains PR B work.
- Regressions fail against the previous code. They cover an aged temp for a
  committed digest, preserved recent temp/committed final bytes, CSV
  write/read/reopen/refusal, aged untracked CSV removal, preserved committed CSV,
  and CSV retention plus failed-unlink/resume through the non-superuser
  execute-only owner login. Root journal copies survive both paths.

### Exact file reference review follow-up (2026-10-11)

- `predictive_blob_referenced(reference)` checks `storage_ref = reference`.
  A committed JSON file does not protect a CSV sibling with the same digest,
  and the inverse also holds. Queue recovery and final orphan cleanup pass the
  actual reference; the current JSON publication paths check their JSON address.
- `predictive_blob_lock_guard(digest)` validates role membership, a canonical
  digest, READ COMMITTED isolation and the held session lock without querying
  ownership. Temporary orphan cleanup calls it separately; SQL never owns a
  temporary filename. The internal reference guard uses the same lock guard.
  PUBLIC execution is revoked; only the retention owner has direct execution
  for the sweep. Its table privileges remain unchanged.
- Both directional regressions fail against the previous SQL, which incorrectly
  reports the unreferenced sibling as owned. They then prove sweep and queued
  recovery through a retention-only non-superuser login, including republication
  under the opposite media type after an unlink failure. A failed JSON diagnostic
  removes its JSON bytes while preserving an already committed CSV sibling.
  Committed files and separate root journals survive.
- This follow-up resets only draft 0003 and its generated contracts using the
  [approved procedure](database-migrations.md#pr-a-draft-period-reset-of-migration-0003).
  Released v1/v2 and readiness minimum 2 remain intact. No hosted database is
  migrated; real CSV parser qualification remains PR B work.
