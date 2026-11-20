# #223 Q0 scratch harness

These are local-only synthetic qualification assets moved from the merged #222
worktree when #223's new worktree was created. q0.sql retains Q0-only synthetic
schema, comparator and fault-injection controls. The application proposal is
../223_paid_leader_gcra.sql and has no fault/comparator argument.

Original Q0 source snapshots and untouched receipts remain in private planning
storage; docs/evidence/subject-223/q0.json contains compact results and hashes.
The relocated harness reads q0.sql rather than the application proposal. Its
source hash therefore differs from the original archived execution snapshot.
This is not a claim that the new application proposal has already passed a
second timing benchmark.

Run only after lane-2 standard ownership and a quiet window are confirmed:

    DB_TEST_LANE=lane-2 DB_TEST_TIER=standard node scripts/db/test-db.mjs up
    node packages/db/proposals/223-qualification/harness.mjs /private/tmp/unique-223-receipt
    DB_TEST_LANE=lane-2 DB_TEST_TIER=standard node scripts/db/test-db.mjs down

Use Node 24, no dotenv or application credentials. The script has a fixed public
throwaway loopback target, two child adapters and a mock provider. Never run it
against hosted storage. Stop only resources owned by this run. The standard
fixture's 512 MiB tmpfs is not a RAM cap, and its non-durable settings do not
qualify production timing. SQL in this directory is not an ordered migration.

## C3 production requalification

`production-requalification.mjs --work PRIVATE_OUTPUT_DIRECTORY` records five
fresh backends' cold-allow, first-denial, warm-denial and warm-allow shared-block
counts plus pg_statio catalog/user-table deltas. No speed assertion runs in
this mode. Deltas include observation/flush work and are not an exact partition
of EXPLAIN buffer totals. It uses the real proposal on a registered disposable
template clone, removes its clones/template afterward, and accepts only lane-2
standard with the guarded public test URL and a credential-free environment.
The output directory must resolve outside Git; receipt writes are exclusive.

`--timing` is a separate opt-in mode: obtain a quiet timing window first. It
times actual parameterized admission calls (not EXPLAIN), on five fresh backend
sessions. It records cold allow and first denial separately from warm branches,
and screens each phase's p95 against 37.1 ms (53 ms local admission slice with
30% headroom). This is local pg TCP comparison, not hosted Neon/driver proof.
Neither mode performs provider calls. Use Node 24 and the same env -i,
DB_TEST_LANE=lane-2, DB_TEST_TIER=standard, TEST_DATABASE_URL public loopback
configuration as the core DB test harness. Never inherit application secrets.
The timing mode alternates a warmed floor-only baseline before/after the five
admission trial groups, on a separate backend so it cannot warm the cold
admission backend. Timing mode was not executed in the C3 non-timing window.
