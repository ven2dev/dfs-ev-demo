# PR B canonical source lineage

This is the next recorder's design and executable pure contract, implemented in
`sourceLineage.ts`. **It is not a database schema or a publication API.** The
read-only normalization planner is implemented; canonical CSV publication,
binding storage and hydration remain unimplemented. Migration 0003 is frozen.

## Two identities, two chains

The stable raw identity is the source profile plus the existing raw-key digest:
`[rawGameId, rawTeam, rawPlayerId]` for player statistics, and
`[rawGameId, rawTeam]` for team statistics. A canonical bridge correction changes
neither identity. Profiles never share a correction chain. The current adapter
supports only its qualified 2026 statistics scope; expanding seasons needs its
own parser/storage qualification.

Released v3 observation chains are per canonical entity, profile and raw source
record. Their foreign key deliberately prohibits a predecessor in another
player/game's chain. Preserve that constraint. Add a separate append-only raw
binding chain which chooses the currently contributing canonical revision.

| Transition | Raw binding predecessor | Canonical observation action |
| --- | --- | --- |
| First usable claim | None | First revision at its entity |
| Changed values, same entity | Previous raw binding | Append to that entity's previous revision |
| Identical payload, refreshed provenance | Previous raw binding | Attach its existing revision; record the new exact provenance |
| Bridge changes player or game | Previous raw binding | Append at the destination entity, using that entity's prior revision if one exists |
| Return to a previous entity | Previous raw binding | Resume that entity's chain; attach if unchanged, otherwise append |
| Unavailable normalization | Previous raw binding | No canonical revision; withhold the raw contribution |

Example: raw record X maps to player A, then B, then A. Its binding chain is
`X1 -> X2 -> X3`. The A observation chain is `A1 -> A2`; B has `B1`. A2's
canonical predecessor is A1, while X3's raw predecessor is X2. Those links serve
different purposes. A root at a new canonical entity is always attached to the
existing raw binding chain; it is never an independent replacement root.

`planSourceBindingTransition()` proposes append/attach/withhold and the expected
raw head plus destination predecessor. It mints no IDs and writes nothing.
`sourceBindingHeadsAt()` follows cutoff-visible raw binding chains before any
canonical routing. At X2's cutoff it returns B1 and no contribution to A; at
X1's cutoff it still returns A1. Filtering to A before following X's chain would
incorrectly resurrect A1. Equal recorder times are ordered by predecessors,
never ID or row order. Missing ancestors, branches, cycles and time regression
refuse the read.

Rerouting assumes the normalization planner has a usable destination mapping and
schedule. The ledger does not resolve conflicting old schedule aliases or bridge
heads: until that evidence is reconciled or retired, normalization withholds.
The game-remapping fixtures isolate the ledger with valid destination plans;
they do not establish an end-to-end reschedule/publication workflow.

A withheld head supersedes earlier contributions without manufacturing an
`absence-v1`, zero, DNP or a participation decision. Reappearance follows the
same raw chain. An actual provider change to a raw-key component is a separate
remove/add case requiring compatible complete snapshot evidence; do not infer
a relationship from names or equal numeric values.

## Required database implementation

The following remains work for a forward migration and its integration tests:

1. Add raw binding events with immutable ID, profile/raw key, unique predecessor,
   database recorder time, requested cutoff, plan/transform versions, state and
   canonical observation reference. Enforce one root per raw lineage, same-lineage
   predecessor, monotonic recorder/cutoff time, and exactly one linear head.
   Separate row/dependency relations must use restrictive foreign keys to exact
   raw capture/ordinal/fingerprint, bridge/schedule revisions, identity links,
   reconciliation decisions and rights decisions. Store a verifiable witness,
   not just a payload hash.
2. Provide a role-checked recorder which chooses its database clock and evaluates
   the newest complete raw snapshot and current bridge/schedule heads again
   inside the publication transaction. A caller's plan digest is not authority.
   Use the existing publication/profile locks in a consistent order, serialize
   raw heads, compare the expected predecessor, and commit the binding plus any
   canonical revision atomically. Current rights must cover both the source and
   every dependency. The application must verify source bytes before recording;
   SQL must independently enforce the permitted projection and exact identity
   bindings. Do not grant unrestricted direct binding INSERT.
3. Require every real-source canonical stats row to have this binding. The old
   JSON writer must not bypass it by wrapping generated JSON in a real provider's
   metadata. Keep CSV outside `predictive_artifact_observations` unless a forward
   replacement explicitly enforces the new raw association. The existing
   tightly guarded synthetic harness remains a separate proof path.
4. Hydrate bound stats from the exact CSV records, re-parse and recompute the
   versioned canonical payload, and verify all pinned normalization dependencies
   against their bytes. A generated JSON witness supplements this proof; it is
   not the provider's original artifact. Preserve duplicates' record ordinals.
   Evidence availability is no earlier than the binding's recorder time, even
   when all provider captures predate it. Current rights remain a separate access
   check, including rights on the bridge/schedule profiles.
5. Expand discovered raw chains before canonical routing for both application
   and SQL reads. Reconciliation, participation, final-label head checks and
   post-window capture checks must use the same binding-aware view. Updating
   only feature replay would leave stale-label and stale-decision paths. An
   identical recapture can attach an existing canonical revision, but its new
   binding must retain the precise source and bridge evidence used at that time.
6. Include binding rows, witnesses and canonical dependents in retention closure.
   Deleting a raw capture, pinned bridge or binding ancestor removes affected
   bindings and their descendants, including descendants routed to another
   canonical entity. Then remove dependent decisions, labels, feature runs and
   blobs through the existing execute-only APIs/digest-lock protocol. No surviving
   event can become a new root or fall back to a deleted predecessor. Preserve
   released audit digests for events with no newly introduced row kinds.

SQL coverage must include recorder-only non-superuser publication, direct-SQL
negative cases for each binding invariant, concurrent stale-head attempts,
rollback/crash blob recovery, empty/upgrade/no-op migration checks and retention
re-apply. The real-source proof still requires actual registered bridges and
observed captures. Pure ledger fixtures do not qualify any provider or authorize
canonical writes. Completion, complete population, membership, schedule coverage,
history and hosted activation retain their existing gates.

## Test reasoning

The 42 pure cases use hand-authored binding IDs and canonical predecessors.
Expected links are not generated by the transition planner under test. Raw-key
hash oracles use explicit literal tuples. The tests assert actual contributions
at earlier and later cutoffs, not only digest changes. They cover A/B/A routing,
missing-row withholding/reappearance, numeric corrections via the stats
planner, independent team/player/profile identities, exact recapture provenance,
same-time ordering, and malformed/branched/cyclic histories. A late event cannot
backdate knowledge to its source capture. Future invalid payloads do not poison
earlier cutoffs, while unreadable recorder timestamps refuse because visibility
cannot be decided.

These tests exercise an in-memory contract. They do not establish database clock
authority, role isolation, concurrency, rights enforcement, retention closure or
raw-file authenticity. Those are mandatory in the forward integration above.
