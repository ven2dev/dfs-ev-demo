# #106 original-byte context adapter: implementation boundary

Checkpoint: 2026-10-14. This identifies the next engineering dependency for the
real QB slice. It does not register a parser/profile, mint canonical evidence,
approve a new source use or allocate a migration. #118 owns 0020; frozen
0001–0019 stay unchanged. Keep this increment unnumbered until its DDL footprint
and the next shared prefix are coordinated here.

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
