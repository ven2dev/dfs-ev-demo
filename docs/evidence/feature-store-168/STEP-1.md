# Step 1: measurement controls, not capacity qualification

The new capacity mode extends `prediction-benchmark.ts`; its normal #167 mode
and all #167 evidence remain unchanged. Step 1 tests the measurement path. The
six final trials wait for the measured sources to be approved and committed.

The metadata selector finds 6,382 real usable QB player-games. The pinned list
contains 100 distinct QBs, all 32 teams, a 1% maximum player share, every exact
n=2–16 and all 15 season/history cells. Each trial uses that identical schedule.
The hashed manifest carries the required minima (20 QBs/16 teams), 5% player cap,
identities, versions, policies, mode, knownAsOf and cutoff. Neither labels nor
training membership selects requests.

The control record contains one fresh-process request and one warm-process
request, all-n 2P/server-work probes, model-only 2 SQL, and a separate existing
process that observes rights revocation and dataset deletion. Available requests
retain exactly 3 SQL / 2 combined checks / 1 descriptor GET and zero request
hashes. Detailed control responses remain in the ObjectStore record and bundle;
the compact receipt retains their verdicts and work only.

These two samples establish no percentile or capacity result. The final
C1/W1/C2/W2/C3/W3 trials still need 100 available predictions each and independent
p95 ≤210 ms / ≥30% headroom. The parent times cold samples from before fork to
complete serialized receipt, and stops on a refusal, work mismatch, 300 ms
deadline, startup-only duration above 210 ms or completed-trial p95 miss.

The Step 1 validation record retains the initial pre-timing wrong-role failure,
subsequent control attempts and test logs. Earlier attempts have their own source
hashes and are not re-labelled as proving later bytes. A sandbox loopback EPERM
is retained alongside the successful unrestricted Node 24 test run. No cleaner
failure occurred. Tests exclude `codex-briefs/**`.

All detailed records first pass through local ObjectStore. The append-only
`step-1-full-records-*.tar.gz` bundle mirrors those exact bytes with sorted
members, fixed metadata and gzip -n. Compact receipts name safe relative members
and retain uncompressed SHA-256/size. The auditor hashes each member before
parsing and recomputes the controls/receipt; the validation record's logs are
hash-verified. It can run with Node 24 and tar, without node_modules, cache or DB:

```sh
node services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit docs/evidence/feature-store-168
```

CI tests use synthetic times to prove per-trial gating and failed-sample
retention, plus deterministic work/tamper controls. No live machine-speed test
runs in CI. A rerun creates a new manifest/sample hash and new files; it does not
replace prior committed evidence.
