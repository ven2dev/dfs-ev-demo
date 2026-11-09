# #258 requalification evidence

The producer and replay runs used committed checkpoint `cad93c9`.

- The [producer receipt](benchmark-20261109T082351Z.json) records all 30
  attempts passing on lane-3 large. The slowest ingestion pair was 11.588 s
  against 42 s, with 12 SQL statements per ingest. The slowest 2025 feature
  run was 4.813 s against 84 s, with 8 SQL statements per run. The journal
  audit passed. Of 77 measured source pins, only proposal 138 changed from
  the [#169 baseline](../feature-store-169/benchmark-20261109T061738Z.json).
- The [replay wrapper](checkpoint-3-qualification.json) verifies the raw
  receipt hashes for [run 1](checkpoint-3-replay-1.json) and
  [run 2](checkpoint-3-replay-2.json). Both runs matched the pinned #244
  baseline across 16 objects, 103,468 normalized rows and 20 derived
  contexts. Missing and corrupt input refusals passed. The #244 code
  identity and #250 proposal-template digest change with proposal 138.

## Producer archive disposition

The producer receipt retains its original archive reference. The archive
`records-20261109T082351Z.tar.gz` is retained locally outside Git.
Its compressed SHA-256 is
`4759f170539be4a11263bbe90b4d208b2640fbe41e5608a8fdceea4e67856389`.
Its sole member, `run-20261109T082351Z.json`, has SHA-256
`691b44922a81e4ccd89fd9ecec6cee5ef0cbe0d50bd54e56f00475b1100af1e0`,
matching the receipt's uncompressed record hash.

The scan followed the [#197 inventory method](../../197-roadmap.md#scan-scope).
It decompressed the archive in memory, searched the structured records and
events recursively, and decoded the 77 embedded source files. The
`sources.json` record includes an exact copy of the
[#138 ingestion receipt](../feature-store-138/step-3-real-ingestion.json).
Its SHA-256 matches the [#197 inventory](../feature-store-197/tracked-payload-inventory.json),
which records a 2025 row-level participation-gap diagnostic. Keeping the
archive outside Git avoids distributing another copy of that diagnostic.
