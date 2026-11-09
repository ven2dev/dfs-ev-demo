# #173 readiness evidence

`step-1-ledger.json` is an inventory and preliminary verdict, not a new database
or performance run. It binds the original criteria and owner amendments to
existing evidence at checkpoint `286f4d0`, with receipt SHA-256 and Git blob IDs.
It distinguishes measured identities, final merged PR heads and independently
confirmed review history. Unestablished reviewed SHAs remain gaps.

Read it with [the design and provisional verdict](../../feature-store-thin-slice-verdict.md).
The dataset and prediction current-source capacity entries remain blocked until
the two owner-approved reruns finish. No lane, timing or database check ran in
step 1. Historical passes and failures retain their original qualification scope.

The source comparisons hash committed bytes at the pinned checkpoint against
the named receipt's source map. A mismatch records byte drift; its explanation
separates runtime, comment-only and setup/environment changes. A matching source
map is not an independent re-execution of a benchmark. Likewise, a hash match of
a receipt is not independent proof of that receipt's behavioral assertions.

Add future receipts and bundles with new names; do not overwrite this ledger or
any predecessor issue's evidence. Detailed persisted artifacts use ObjectStore;
durable in-tree compressed mirrors keep the owner-approved audit policy. Keep
all failed attempts and any stopped run with its error and boundary metadata.
