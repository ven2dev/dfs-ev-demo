# #106 original-byte context adapter: implementation boundary

Checkpoint: 2026-10-14. This identifies the next engineering dependency for the
real QB slice. It does not register a parser/profile, mint canonical evidence
or approve a new source use. Frozen 0001–0020 stay unchanged. #106 owns 0021
only for the context recorder; #118 owns 0022–0024 for subsequent foundation
review fixes, to finalize after integrating frozen 0021. No later number is
allocated. The 0021 migration is not yet implemented by these pure preparation
checkpoints.

## Why the existing publisher is insufficient

`validateDataset` parses an ordinary artifact as a JSON array of strict revision
envelopes. `publish` stores those bytes and links the resulting observations.
That supports native JSON evidence and synthetic fixtures; it does not parse
original nflverse schedule, identifier or weekly-roster CSVs.

`predictive_source_canonical_guard` in 0013 intentionally rejects canonical
artifact/observation associations from gzip and registered raw CSV sources.
Schema 18 provides a separate numerical binding recorder, not a context adapter
for schedule, identity and membership. A generated JSON envelope attributed to
an original provider CSV would lose original-byte authentication. Changing the
parser name or source profile must not become a workaround.

## Narrow increment

Start with original plain schedule and identifier snapshots. Preserve exact
wire bytes, full-file scope, header profile, complete row ordinals and explicit
projection refusals, with registered selected columns and existing budgets.
Support schedule season selection without deleting rows from the retained
provider file. Do not infer independent schedule completeness from that file.

The application decoder prepares raw context claims, not caller-authored
canonical revisions. An execute-only recorder must independently validate their
registered feed/scope, complete coverage and selected-row provenance, then bind
the requested raw identities. Internal canonical event UUIDs may be minted at
recording time; the raw-to-canonical association still requires explicit source
evidence and conflict checks. Reuse must preserve event identity across schedule
corrections. Canonical identity knowledge begins at database recording, not an
upstream release timestamp or a guessed historical date.

GSIS-native player identity is explicit rather than name-matched. Other provider
crosswalk IDs retain their namespaces. Resolve duplicate raw IDs and reverse
raw-to-GSIS ambiguity before creating a mapping; an earlier source row must not
survive a conflicting correction. Statistical profile/bridge links are recorded
separately, with the required use-specific rights and source evidence.

Weekly roster support follows through the versioned complete gzip decoder.
Weekly team/position/status claims do not contain exact effective timestamps.
Do not fill career-long or season-long membership bounds, treat ACT as offensive
participation, or claim former-team completeness from one season. Register and
justify any game-scoped membership interpretation before turning it into the
required half-open effective intervals. Preserve unresolved cases.

Derived context associations must point to the original capture and source-row
proof, with exact replay against those bytes. They must enter the same current
rights/deletion guard as the numerical path, including fresh delivery/commit
checks and transaction-local byte accounting. Mandatory deletion must remove
dependent context, numerical consumers, inventories, datasets and pins. Pins
must not retain evidence past required deletion.

## Verification scope

Pure parser cases cover exact headers/ordinals, selected-column allowlists,
invalid IDs, duplicate/reverse conflicts, schedule date/team consistency and
explicit refusal of invented membership bounds. Database cases are reserved for
the recorder boundary: non-superuser permissions, rehashed forged claims,
correction/cutoff behavior, concurrent rights/deletion, rollback/restoration and
dependent closure. Run focused cases while implementing; run the combined full
gate when the new prefix and shared readers reach their integration checkpoint.

Official participation/reconciliation and independently enumerated three-season
coverage remain separate real-evidence prerequisites. This adapter must not
manufacture those decisions to make the consumer fixture succeed.

## Current real identity intake

The verified acquisition journal
`f319cca7093bc033661b8f723da41b40d0968fd1cac1b8288b46984fcb6323cc`
supplies original identifiers, 2026 weekly roster and schedule bytes. Private
`context-intake.json` in the durable acquisition root records the exact selected
row ordinals/fingerprints, reverse-crosswalk findings and weekly team/status
claims. It records no canonical bridge or membership effective intervals.
This is the concrete source intake for the parser increment, not an eligible
context batch. Full raw values remain outside Git.

## Pure context preparation checkpoint

`sourceContextClaims.ts` implements `nflverse-original-context-claims-v1` for
original plain schedule and identifier CSVs. The request pins capture identity,
feed, wire size/hash and an explicit three-season schedule range. Exact headers
and selected-column allowlists use the existing source parser. Limits are
8,000,000 bytes per file, 80,000 records and the existing 65,536-byte CSV record
limit. The legacy numerical CSV publisher's 8,192-row bound is unchanged.

Every parsed row retains its physical ordinal, capture-specific row ID, raw-key
digest, selected-column fingerprint and either a raw projection or explicit
refusal. Out-of-range schedule rows remain in the complete claim array; no
filtered provider file is created. Schedule keys, teams and local kickoff times
are checked, including REG/POST round classification and ambiguous DST refusal.
Identity uses GSIS plus namespaced raw crosswalk IDs. Differing duplicate raw
keys and reverse crosswalk ambiguity withhold all involved rows. Calendar years
outside the represented season and following year are refused. Refused rows
still participate in reverse ambiguity, so an invalid position/missing GSIS
cannot make a shared provider ID appear unique. Excluded fields affect wire
identity but do not enter selected-row fingerprints or raw projections.

This is preparation, not authorization: it does not establish provider origin,
rights, capture completeness or canonical truth from a caller-supplied hash.
The future publication boundary must verify the registered profile, original
acquisition metadata and complete file, then independently validate/bind these
claims. No ordinary publisher, SQL guard, canonical recorder, profile or training
reader is altered here. Roster feeds and supplied membership bounds are refused.

Twelve focused cases pass, covering hand-specified target kickoff/teams, complete
ordinals/refusals, POST, DST, exact duplicate preservation, differing duplicate
withholding, reverse ambiguity even with invalid position/GSIS, namespace
separation, unselected data, false wire identity/header and mutable request
isolation. All twelve also pass in the final 587-case predictive suite. Typecheck
and affected-file lint pass. No database gate was run for this pure increment.

Real proof reverified the retained acquisition journal before reading the exact
original files. All 7,548 schedule rows were retained: 842 raw projections and
6,706 explicit refusals (5,617 out of range, 879 invalid schedule keys/grain,
210 unavailable kickoffs). All 24,854 identifier rows were retained: 18,774
projections, 6,078 invalid/missing GSIS refusals and two reverse-ID conflicts.
The proposed target game and QB each have one projected row. Preparation took
654/743 ms respectively in the final run; this is not a guarded database benchmark.
Private proof retains the source/header/claim-array hashes and exact selected
row provenance. No canonical context, membership interval or feature/label was
published. Next: the independent context recorder/association contract after
Relay freezes 0020 and migration allocation is coordinated here.

## Context publication preparation after frozen 0020 integration

`sourceContextPublication.ts` adds detached original-byte preparation for
schedule/identifier context. It pins caller input before awaiting parsing and
validates metadata/rights envelopes, the explicit context parser version, exact
provider/release/asset/header and selected-column version. Original scope must
be unfiltered `all-seasons` with full retrieval; three-season schedule selection
stays separate from original-file scope. Profile evidence kinds are player
bridges for identifiers, and schedule/game bridges/team aliases for schedules.
Roster membership and effective timestamps are not accepted here.

The supplied rights chain must allow research at both capture and preparation.
Future capture/registration/review dates and release updates after capture are
refused. Original bytes must pass size/hash/header and complete-row checks.
The result pins rights references and request identity; it grants no rights and
publishes no canonical context, feature or label. The eventual recorder must
verify persisted registrations/rights under the guard, obtain database recording
time, independently validate claims and recheck current rights before commit.
New evidence dependencies must extend 0020's protected table set and memo keys.

Eight focused cases cover both feeds, provider/origin/parser/filter substitution,
adapter-only rights, expiry, late grants, later revocation, future capture,
damaged bytes and caller mutation. Fixture terms records are test-only. All
813 Node tests, typecheck, affected-file lint and whitespace checks pass.
No real registration, rights insertion or SQL context record is claimed.

## Scratch raw-context recorder checkpoint

`db/prototypes/0021_original_context.sql` and the local store's
`publishSourceContext` / `replaySourceContext` implement the first recordable
slice in registered disposable databases. **This is not frozen 0021.** Ordered
migrations and generated catalog/schema artifacts remain at 0020. On that
unchanged prefix, both methods refuse `context-recording-not-installed`.

The prototype seals a complete original CSV capture and its entire claim array.
Publication uses an ingest-plus-replay login; replay-only and retention-only
logins exercise their separate existing permissions.
Published capture/run rows require a matching seal at commit; source receipt
time is database-stamped. Registrations and authoritative rights are checked
before file publication. Every raw replay holds the shared guard, rechecks
current rights/deletion before bytes and delivery, verifies exact wire bytes,
reparses the complete CSV and compares every claim. A well-shaped raw ingest
seal alone is not evidence authority. SQL validates structural/key/ordinal,
scope, conflict and Eastern kickoff consistency; the application still must
reconstruct claims from original bytes. Canonical associations remain blocked,
including direct ordinary native JSON association attempts.

The private seal table joins the read guard and 0020 memo dependency set by
forward prototype DDL. A write-capable lock on it disables memo reuse. Mandatory
source deletion cascades the seal under the existing authorization, adds a
digest-only supplemental row-count/ID audit and uses the existing blob removal
queue. Existing byte-reading/retention signatures and legacy numerical limits
are unchanged. An 8,193-row context capture succeeds while the same run size
under the released CSV numerical code version is explicitly refused.

Ten mandatory PostgreSQL cases pass: restricted roles and both feeds, 8,193
records, forged SQL ordinal/kickoff and missing-seal commits, changed bytes and
rehashed stored claims, native association refusal, commit-time rights expiry
with complete rollback/file cleanup and recovery, unavailable-prefix behavior,
mandatory deletion/resurrection refusal, memo/orphan-run protection, and exact
canonical hash parity with escaping/Unicode/nulls/array order. The full focused
run took 12.43 seconds; the later strengthened legacy-bound case also passed.
All 813 Node tests, six report-contract checks, typecheck, affected-file lint
and whitespace checks pass. No full database gate was repeated.

Actual original-file proof reverified the durable source journal, recorded the
existing selected core-feed internal-research review, and published/replayed both
complete sources in a scratch database. It grants no model-input, outcome-label
or public use. Schedule: 7,548 rows, publication 2,306 ms, two replays 1,577 ms.
Identifiers: 24,854 rows, publication 6,787 ms, two replays 2,815 ms. Both repeated
replays are identical; zero canonical observations/features/labels are created.
Original October 14 receipt times are preserved; SQL ingestion/recording clocks
are later actual times. The scratch database and its private blob files were
removed; original source archives remain under their existing retention receipts.

The first real identifier run reached the unchanged 10-second SQL timeout.
The fix specializes canonical serialization to this exact validated schema,
preserving the original digest bytes while removing recursive per-scalar SQL
calls. Independent comparison against the released general canonical hash and
the TypeScript digest passes. No timeout or source limit was raised. Final
proof retains the SQL and application file hashes. The draft SQL hash is
`2e0d1a01f8330a94cc9f6f4ffc7514431b9cb26b7fdbc2ecb784f52550c9856b`;
it is a measurement identifier, **not** a frozen migration checksum.

Next: canonical association authorization and replay. New bindings must not
retroactively attach facts to the earlier raw capture's cutoff. Recording time
and the immutable authorized association set must govern all SQL/application
readers, with original-byte authentication and complete deletion/dataset closure.
Only after these paths and their regression/upgrade checks pass can 0021 be
promoted and frozen for #118's reserved 0022–0024. Dated membership, independent
schedule coverage and permitted completion/participation/reconciliation evidence
remain separate source qualifications.
