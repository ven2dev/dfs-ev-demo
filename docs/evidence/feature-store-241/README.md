# #241 evidence

Step 1 qualifies the shared completion relation and derived feature/label
display changes. Final dataset, producer and #163 speed qualification belongs
to step 4; no step-1 timing is presented as that proof.

`step-1-validation-20261107T214813Z.json` records the base commit, source SHA-256
and Git blob identities, completed validation commands, nine probe verdicts and
one-statement/inlining observations. Its exact full validation record and the
new DB probes are retained in `step-1-full-records-20261107T214813Z.tar.gz`.
The bundle also retains the initial sandbox-denied setup attempt: no probe
executed in that attempt. It is not counted as a passing test.

Audit from the repository root with Node 24, without a database or local cache:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit docs/evidence/feature-store-241
```

The existing TypeScript auditor checks each named member's SHA-256 and byte
size before parsing, then reconstructs the receipt's exact generic projection.
It does not rerun the database checks or independently derive their verdicts.
The archive has sorted regular-file members, fixed timestamps/owner IDs and
`gzip -n`; two constructions produced identical bytes. Records are durable
in-tree bytes, independent of `node_modules/.cache` and disposable sources.

| Member | SHA-256 | Verdict |
| --- | --- | --- |
| `step-1/job-visibility.json` | `394f8b5ce016ed7d99c6549ab86eda143c7e518d8dae1e9e36a1b2737de298ae` | Nine DB probe groups pass. |
| `step-1/sandbox-setup-attempt.json` | `9a688f8482fc2c872804b788c29d5a2218638d0fa56751b88f9dfe3e80154a4b` | Setup denied; zero probes executed. |
| `step-1/validation.json` | `c7189664874fd0842c4c4a7b09b84b2a727d059826d90cb5fa046819ce58cda8` | Completed validation passes. |

Step 1 uses synthetic revisions with actual insertion/finish/COMMIT clocks and
real restricted LOGINs on the loopback PostgreSQL 18.6 fixture. No stored clock
is altered. Both feature and label probes record the accepted terminal-UPDATE
to-COMMIT visibility gap. The generic evidence projection is a receipt of
executed assertions, not an independent plan or temporal proof engine.

Future runs add new receipts and bundles; a rerun produces a new record hash.
Existing #166/#167/#231 evidence remains unchanged.
