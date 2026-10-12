# PR B canonical source lineage

The pure contract in `sourceLineage.ts` now has a PostgreSQL recorder and verified
hydration path under forward migrations 0005 and 0006. **These canonical source revisions
remain internal research staging.** They do not enter `predictive_observations`,
model inputs, participation/reconciliation decisions or labels. Full activation
must update every reader's head rules together. Migration 0003 is frozen.

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

## Storage checkpoint implemented in 0005

`recordSourceNormalization(id, requestWithoutCutoff, expectedHeadId)` chooses its
cutoff from the database clock, verifies raw CSV/JSON evidence and calls the
execute-only recorder. SQL independently reconstructs the exact raw rows,
canonical identity, effective player bridge, schedule context, links, decisions,
rights and candidate. A correctly rehashed forged candidate is refused. A global
publication lock and SHARE evidence locks protect the validation; expected-head
comparison prevents concurrent branching. Binding ID retries must match the
original request/predecessor and have current rights, and reverify original files.
No caller supplies `recorded_at`.

Bindings reference raw captures/rows, every relevant bridge/schedule head,
identity links, reconciliation decisions and rights through restrictive foreign
keys. Positive candidates append or attach revisions in
`predictive_source_stats_revisions`; unavailable raw rows create a null-revision
binding. The original 0005 checkpoint records `source-row-missing`,
`source-row-refused` and `source-row-ambiguous`; 0006 expands unavailable states
as described below. A disappeared row never becomes zero, confirmed absence
or an absence-v1 observation.

`replaySourceNormalization(request)` uses a replay-only, repeatable-read,
read-only snapshot. It verifies stored association sets, recomputes each original
plan using its original knowledge/access clocks and independently validates the
raw/canonical lineage. It separately checks current research rights before
hydrating historical bytes. It then replans at the requested cutoff: unrecorded
new raw/context evidence withholds the contribution as `source-binding-stale`.
There is no fallback to an older usable binding. A cutoff-only change or renewal
of equivalent research rights does not manufacture a statistical correction.
Stale/revoked responses expose no historical canonical payload.

Verified files are cached only within one operation and the cache is discarded
at transaction end. Reads refuse more than 256 bindings or 20 MB of distinct
verified source bytes. These are explicit operation bounds, not a production
throughput guarantee. A generated JSON artifact under a real CSV profile cannot
bypass the staging boundary; the existing synthetic JSON harness remains separate.

Retention deletes every binding and canonical revision in an affected raw
lineage, including ancestors and descendants, whenever it removes a cited raw
capture/row, bridge/schedule capture/artifact/observation or decision. This is
stronger than removing only the tail: an earlier binding cannot reactivate.
Raw files not included in the requested source scope may survive, but require
fresh recording. Associations are deleted before their restrictive references.
New audit kinds/counts appear only when those rows exist, preserving older
retention audit parity. Blob removal still uses the released execute-only APIs
and digest locks. There are no new generated blob files to recover.

## Unavailable states implemented in 0006

Plan v2 pins current research rights on every result, including early failures,
except an access-refused response. The SQL planner independently reconstructs
the same ordered checks as TypeScript and requires an exact witness. A missing
bridge cites the evidence already reached; a conflicting bridge or schedule
cites every relevant competing head. Missing/ambiguous source captures and
removed-evidence states are recordable without invented rows or identities.
All cited capture files are independently parsed and checked, even when their
contents conflict. Context rights are checked before opening context files.

The unavailable raw head supersedes an earlier usable binding. Recovery follows
that head; identical values reuse their canonical revision. No absence, zero or
participation decision is implied. Recorder validation rechecks the complete
witness at current database time, so unrecorded raw/context changes invalidate
stale proposals. V1 records and exact retries still reproduce their original
version; fresh records use v2. Freshness ignores only the v1/v2 envelope version,
clock fields and rights-decision IDs, with rights enforced separately.

Source retention removes the entire lineage of capture-less bindings when
their source is scoped. This is conservative for time-limited deletion because
a capture-less event has no provider capture time to establish an exemption.
Existing cited-evidence closure and backup audit parity remain in place.

## Remaining activation work

The application preparation now includes
[`sourceWitness.ts`](../src/lib/predictive/sourceWitness.ts). A consumer witness
pins every contributing raw lineage's profile, canonical entity, binding ID,
revision ID and head token, plus applicable withheld evidence and explicit
missing requested entities. Its digest excludes query time, so reading unchanged
evidence later does not by itself stale a decision. An unchanged recapture does
change the witness: the statistical revision can be reused but the binding and
source capture cannot be replaced without new provenance. Unknown current
routing remains applicable to every entity filter in the requested profiles.
Known unrelated destinations can be excluded from a narrower witness.

The same witness supports a read-only reconciliation-v1 assessment, the F3
positive-usage contribution and a post-window source-capture check. Existing
reconciliation and participation policies share their numerical predicates with
these helpers. Withheld evidence prevents selecting a usable rival or inferring
usage. A zero/blank/missing usage row does not establish absence or zero
participation. Multiple providers must all show positive usage to contribute
that evidence; yardage disagreement alone does not negate positive usage.
Explicit inactive/snap evidence still needs the complete participation policy.

The post-window check requires an unchanged complete witness and the exact
reconciliation-v1 selection. It checks the selected binding's own raw capture,
including its capture time at/after the eligible boundary and ingestion at/before
the read cutoff. An unchanged revision first recorded before the window can be
reconfirmed by a later bound recapture; the old capture cannot stand in for it.
Agreeing sources use the same deterministic selection as reconciliation-v1;
conflicting sources cannot supply a selected post-window capture.

These helpers consume verified snapshots; a digest is not evidence of source
authorization or database publication. `unchanged` can describe an empty set
and does not establish a usable selection or complete population. Capture
confirmation alone establishes none of the other final-label checks, including
qualified completion, identity, current outcome-use rights or a persisted
participation/reconciliation decision. The witnesses are research application
preparation, not a new stored decision format or SQL activation. Existing
features, decisions and labels still use the released contracts until the
shared SQL rule and forward recorders are implemented together.

`sourceFacts.ts` and the persisted `replaySourceStatsFacts()` now implement the
application's preliminary research read boundary: complete raw-chain discovery
inside requested profiles, verified current replanning, raw heads before
canonical filtering, explicit withholding and exact binding tokens. Revision
knowledge is no earlier than its first binding recorder time. A new binding
can reuse an unchanged revision while preserving its new provenance. This API
does not feed existing feature, reconciliation, participation or label paths;
it cannot substitute for the shared SQL head checker those paths still need.
Its `recorded-lineages-only` coverage establishes no eligible population.

The current profile-wide discovery is deliberately conservative and bounded,
including chains whose unrecorded current plan maps to a new destination.
Replacing it with indexed canonical discovery must preserve that case, not just
expand chains already routed to the requested entity in historical revisions.
Any overflow refuses the operation. Source/context rights are checked before
opening historical bytes; inaccessible history is not parsed to determine
whether it might be irrelevant. These are research limits, not roster-scale
performance or qualified provider evidence.
Unresolved current routing remains explicit for every canonical filter inside
the requested profiles. A historical destination cannot prove that the current
unresolved claim is unrelated to another destination. The preliminary selector
withholds rather than silently dropping that uncertainty.

The original implementation requirements below distinguish the completed
storage boundary from the downstream work still needed:

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

The pure tests exercise an in-memory contract. Thirteen additional mandatory
PostgreSQL cases establish recorder clock/role isolation, linear concurrent head
selection, exact corrections and rerouting, missing/refused/ambiguous withholding,
rehashed forgery refusal, raw-byte and association tamper refusal, current-rights
revocation, stale unrecorded context, immutable rows, the JSON bypass guard,
retention of whole raw lineages, restored deletion-set parity and v4 upgrade/no-op
preservation. Expected values, revision predecessors and removal counts are
hand-specified. Two independent sessions are observed waiting behind a held lock
before the concurrent test releases them; it is not a timing-only race test.

Restoration tests re-import identical evidence into fresh scratch databases and
recreate binding IDs. They prove deletion-set/count/digest parity, not restoration
of original database clocks. Tampering uses privileged fixture mutation solely
to verify hydration refusal; those privileges are not granted to replay or
recorder users. This checkpoint creates no generated file, so the released blob
rollback/crash suite remains the filesystem recovery proof. Synthetic bridges
and corrections do not qualify real providers or demonstrate observed provider
corrections. Full feature/decision/label activation remains outstanding.


Nine additional mandatory PostgreSQL cases cover exact failure-prefix and
conflict witnesses, rehashed failure/rights/dependency forgeries, usable →
unavailable → recovered history, every conflicting capture's byte integrity,
capture-less source retention through a non-superuser owner, v5 upgrade with
v1 positive/withheld plans and retries, absence heads and effective-window
boundaries, current/stale schedule reconciliation and rights before hydration.
Expected failure reasons, dependency roles, revision counts and canonical
reconciliation input order are hand-specified. These synthetic tests do not
qualify real-source identity, completion, population coverage or history.
