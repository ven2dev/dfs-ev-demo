# #138 evidence receipts

These files are compact receipts, not full logs, copied source code or SQL plans.
Each `archiveKey` resolves through [archive-index.json](archive-index.json).
That index records the SHA-256, byte count and line count of every exact original.

Full committed evidence and all six original approved commits are preserved at
the remote [spike/138-evidence tag](https://github.com/ven2dev/dfs-ev-demo/tree/spike/138-evidence),
whose immutable commit is `1383b5c92f815b297497f333017dee720bed10aa`. Full files are available under
[`docs/evidence/feature-store-138/`](https://github.com/ven2dev/dfs-ev-demo/blob/1383b5c92f815b297497f333017dee720bed10aa/docs/evidence/feature-store-138).
For example, the [full query profile](https://github.com/ven2dev/dfs-ev-demo/blob/1383b5c92f815b297497f333017dee720bed10aa/docs/evidence/feature-store-138/step-4-query-profile.json)
and [all failed/superseded matrices](https://github.com/ven2dev/dfs-ev-demo/blob/1383b5c92f815b297497f333017dee720bed10aa/docs/evidence/feature-store-138) remain independently inspectable.
Original raw source objects and previously private step-5 diagnostic archives
were never in Git; their existing private-storage requirements remain unchanged.

## Reading and reproduction

- Recorded verdicts, clocks, per-trial timings, errors, counts, work budgets,
  source/code hashes and correctness probes are retained, including every failed
  or superseded attempt. UUID lists, full plans, copied source, duplicate snapshots
  and complete stdout/stderr are in the archive rather than the PR.
- Historical `sourceManifestSha256`, `baselineInventorySha256` and `evidence`
  hashes name the original archived artifacts, not these new receipt bytes.
  No benchmark was rerun or relabeled by this compaction; earlier passing feature
  measurements remain historical and final producer capacity is still #169.
- Source inventory and final/initial manifests retain the exact `SourceAsset`
  metadata and columns consumed by the existing ingestion/derived/dataset recipes.
  The ingestion receipt retains the local ObjectStore root and original object
  addresses/hashes required by the supplemental participation inspection.
- Obtain a complete original with `git show spike/138-evidence:docs/evidence/feature-store-138/NAME`.
  Validate its exact bytes against this index. Reproduction uses the original
  pinned raw objects through ObjectStore; current public releases can change.
- Fresh opt-in runners may write verbose output at these paths. Before committing
  later measurements, retain compact receipts and archive their complete outputs.

## History and review boundary

The PR branch was rebuilt from its existing main baseline `4e13c0f9770959096acd89ce6db284828b015cac`
with the same application, scripts, tests and proposal-SQL bytes. The old spike
commits remain reachable through the evidence tag, not through the PR's ancestry.
This keeps full diagnostic blobs out of main regardless of squash/merge strategy.
Independent owner review and green CI at the new SHA are still merge gates.


The [queue-progress correction receipt](queue-progress-correction.json) is fresh
post-review evidence, rather than an archived step-3/4 diagnostic. It records the
failing baseline, passing boundary regression and focused validation against
the corrected uncommitted source hashes. Historical receipts remain unchanged.
