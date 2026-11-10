# Producer capacity evidence (#169)

`benchmark-20261109T061738Z.json` is the current qualification receipt for
committed sources `42ef49090748dc947e305a309dd2e3d698d0667e`, after the main
merge and CI worker fix. It retains all 30 attempt durations, verdicts, 12/8 SQL
counts, disk peaks/growth and 77 source identities.
`records-20261109T061738Z.tar.gz#run-20261109T061738Z.json` contains the exact
15,855,474-byte detailed record, including source bytes, journals, loopback pins,
SQL times, WAL/checkpointer/autovacuum observations and raw-cleanup receipts.
Its SHA-256 is `f79f303216ecb8c068ca281ebdd1339fb5d3e2840982c5f677dc21985e535d6f`.

`benchmark-20261109T050208Z.json` and `records-20261109T050208Z.tar.gz` are
unchanged history qualifying only earlier sources
`55d512b15c3e340c128d8b4195783faa00e29385`. Their detailed record remains
15,843,466 bytes with SHA-256
`9daae46fb57f30996dc1c09153a60b41174e314e62671ac7f712ffb918fa1543`.
It does not qualify the current worker. The new run adds files and replaces no
prior receipt, archive or attempt; all 44 records pass the common auditor.

The record was published and read back through a private local ObjectStore at
`audits/<fullRecord.sha256>`. The compressed in-tree mirror preserves the same
uncompressed bytes for independent audit. Both archives use deterministic USTAR
and `gzip -n`; hashes bind the uncompressed records. New runs use new filenames
and exclusive creation to protect history. No raw source downloads are committed.

## Offline verification

Use Node 24 from the repository root. These commands read saved evidence only;
they make no network/database calls and measure no workload in CI.

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit docs/evidence/feature-store-169
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test services/pipeline/tests/feature-store/producer-capacity-evidence.check.mts
```

The common auditor verifies member SHA-256 and byte size before parsing, exact
archive membership and the entire recomputed compact projection. The producer
auditor recalculates the ordered schedule, paired arithmetic, all work/refusal
verdicts, resets, source identities, clock preflights and cleanup. No saved pass
flag substitutes for that verification. Tests also alter real receipt bytes,
work, loopback and diagnostic records to check refusals.

## Measurement contract and result

Four representatives each have three cold/warm blocks: schedule, largest stats
file (2025), largest roster (2021) and largest participation (2023). Each ingestion
attempt times a full original-GitHub-URL transfer using the production transfer
client, including redirects and hashing, then the real downloader, validation,
ObjectStore publication and normalization of exact original bytes through
`openTransferFixture`. `observeLiveDownload` retains observed hash/size and
protocol outcomes without retaining the live body. The conservative paired sum
also includes loopback transfer and observation/IPC overhead. Every receipt names
loopback explicitly even though saved database provenance remains the GitHub URL.
Drift is an observation; HTTP, transport, size-protocol or deadline failures stop
the run, with no replacement. Each pair must be <=42 s and each leg <=60 s.

Feature attempts prepare all 16 original files (246,304,787 bytes, 2021–2025)
through ObjectStore and ingestion outside feature timing, then run full-season
2025 features. Each attempt must be <=84 s under 120 s, with 8 SQL, one bulk
materialization, no per-example queries and no source-byte reads during the job.
It produces 1,948 outputs / 31,168 lineage links; this is distinct from the older
2,504-row dataset qualification. All historical-availability flags are retained.

The current matrix passed: ingestion 0.553–18.139 s, features 6.360–7.419 s,
exactly 12/8 SQL. Every attempt has verified raw cleanup. All six live schedule
observations drifted (516,585 vs 515,250 pinned bytes); the other representatives
matched. Detailed values and feature diagnostics are in the
[design doc](../../feature-store-producer-capacity.md#final-qualification).

Each block fully removes and recreates large-tier lane-3, then uses fresh scratch
databases and empty ObjectStore destinations for cold and warm. Cold includes
new process/native import/connect once; warm prepares those outside timing and
records setup. Timing ends after COMMIT and parent receipt. There are 15 distinct
containers and 30 distinct worker processes. Preparation warms database pages;
tmpfs restarts reset data/shared buffers, not host physical caches. OS, Docker,
DNS and CDN cache states are uncontrolled. No hosted-capacity claim follows.

The owner confirmed a quiet window; only lane-3 / port 54349 was used, with
`DB_TEST_LANE=lane-3` and `DB_TEST_TIER=large` through teardown. Each workload's
preflight passed >=608 MiB free. Actual mount: 2 GiB; sampled peak: 311.227 MiB;
growth: 265.031 MiB against 466.797 MiB. Disk, WAL, temp files and database sizes
are observations at the recorded boundaries and intervals, not continuous exact
peaks. Ten host/database observations before every block gave a maximum absolute
midpoint offset of 1.457 ms against 250 ms; timestamps were never adjusted.
Container absence was verified at 2026-11-09T06:23:29.458Z and the window closed.

## Retained discovery history and limitations

`discovery-20261109T050208Z.json` references 41 exact original reports, journals,
prototype sources and decision notes plus its summary, mirrored in the separate
discovery archive. Each detailed member and summary was published through
ObjectStore at `audits/<sha256>`. These are historical records, not final
qualification, and their original statuses and bytes are unchanged:

- Initial live schedule size refusal: advertised 516,514 vs pinned 515,250 bytes;
  body cancelled before hash, zero producer SQL, retained censored failure.
- First paired attempt: genuine `23514` timestamp constraint failure with roughly
  30 s host/database skew; the failed pinned path used 10 SQL. No producer fix,
  constraint relaxation, timestamp adjustment or in-place retry was made.
- The next run retained 20 successful ingestion attempts but stopped on an
  unapproved exact-clock-overlap assertion. The owner withdrew that assertion
  and approved only ten previously unstarted IDs under the 250 ms tolerance.
  A separate resume record references the previous report's exact hash. That
  combined 30-attempt spike passed, without relabelling the stopped run.
- Disposable transfer observations found idle backends, no open transactions or
  locks, and zero producer SQL during live and loopback downloads. This sampling
  does not make a continuous lock claim or cover publication's expected locks.
- Spike warm features were about 57% slower; the earlier qualification's changes
  were +1.98%, -5.85% and -6.36%, and the current run's changes are -8.84%,
  -14.27% and -0.68%. Neither run's per-SQL and PostgreSQL observations establish
  the cause. The design doc describes the current warm-3 maintenance observations.

The original fixture remains pinned. Self-hosting was declined because it would
measure Cloudflare rather than the production GitHub network path, and the
existing `edgetrace-fs-test` bucket allows synthetic bytes only. Network variation,
uncontrolled caches, sampled disk/maintenance observations and local hardware
limit interpretation. None changes the absolute targets or SQL budgets.
