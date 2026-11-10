# #261 published-payload inventory

[Design basis](../../evidence-payload-publication.md) ·
[owner disposition](https://github.com/ven2dev/dfs-ev-demo/issues/261#issuecomment-6759765086) ·
[approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/261#issuecomment-6759824721)

`tracked-payload-inventory-f30b93f.json` is an append-only scan of the exact main
tree at `f30b93f23a30316213f07ba346e4a301550d57b0`, before cleanup. It records
901 tracked paths, 33 compressed paths, 360 archive leaf members, 1,530 decoded
JSON strings and 154 decoded base64 sources. Every root/member has SHA-256 and
byte size; roots also have their Git blob and introduction at the current path.
The latter does not claim earlier-path introduction through a monorepo rename.
Findings contain counts and addresses, without row values. Five PNG/ICO files
are enumerated and hashed, without claiming pixel inspection.

`step-1-rescan.json` records the comparison with the independently written
disposable intake scanner, manual text classifications and the test results.
All 901 root identities, 360 leaf identities, introductions and 11 finding
paths/counts match. Expanded bytes here include decoded base64 sources; the
intake's approximate expanded-container total also included 20,480 bytes from
its synthetic nested-archive control. This accounting difference changes no
file/member identity, payload count or disposition.

`payload-dispositions.json` is the explicit hash-bound policy. Three #168/#242
archives are approved for removal going forward, after exact private retention
and readback. They remain in this step's inventory as pending removal; that
decision does not permit republishing them. The owner accepted their existing
public history exposure, with no history rewrite or force-push. The #197
inventory is unchanged.

Both #169 archives stay at their exact approved hashes under the narrow #138
notice extension. Their only payload finding is the exact 22,624-byte original
ingestion receipt, SHA-256
`a08d54d2c8a53eb550a900a81ad32ce70d7fc9e44683fea7dcfd2f310e743db9`,
encoded in each source map. The policy requires that exact original to remain
present and noticed; removal or hold withdraws approval for the copies. #169's
auditor and committed-evidence check remain unchanged. A changed hash or new
copy needs an owner disposition.

For a separate reproducibility scan, use Node 24 from the repository root and
an output filename that does not already exist:

```sh
node services/pipeline/scripts/feature-store/evidence-payload-inventory.ts \
  f30b93f23a30316213f07ba346e4a301550d57b0 \
  docs/evidence/feature-store-261/payload-dispositions.json \
  /private/tmp/261-reproduced-inventory.json
```

The decoder and inventory source hashes and limits are included in the output.
Only exact Git objects at the supplied checkpoint are scanned; untracked and
uncommitted edits cannot enter it. The scanner does not extract archives.
Gzip/regular-file USTAR nesting is supported; unknown containers/binary formats,
malformed structured inputs, unsafe/duplicate members and limit violations fail
closed. Hash-bound, explicitly classified synthetic controls are distinct from
noticed source excerpts; a `synthetic` marker supplies no permission.

## Step 2: retention and two audit modes

`step-2-retention.json` records exact ObjectStore retention and readback of the
three selected archives and all 19 members (22 verified writes/readbacks).
Objects use the owner-selected durable private store outside briefs, mode 0700;
keys in public references are store-relative and reveal no absolute location.
The three public archives were removed only after those readbacks and a complete
private audit. Both #169 archives and their auditor/check remain unchanged.

Each selected archive now has a versioned `.reference.json` with archive/member
hashes/sizes and a hash-bound `.public.json` projection. All original compact
receipts remain byte-for-byte intact. New per-sample projection fields are only
response hash, byte size, status/refusal and timings. No player/game identifiers
or forecast/context values were added. `step-2-audit-parity.json` records the
public/private audit results and their different capabilities.

Public CI recomputes available timings/statuses, schedules, process provenance,
work counts and source metadata. It cannot independently recheck private
forecast/context linkage, raw per-table SQL-oracle counters or validation logs.
Public audit output labels a referenced record `public-metadata`; safe archives
still produce `full-bytes` checks. The explicit private-byte mode reproduces the
complete original verdicts and refuses absent/corrupt private objects:

```sh
node services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit-private \
  docs/evidence/feature-store-168 "$PRIVATE_OBJECTSTORE"
node services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit-private \
  docs/evidence/feature-store-242 "$PRIVATE_OBJECTSTORE"
```

## Step 3: publication guard

`npm run test:evidence-publication` scans the complete tested `HEAD`, with its
policy read from that exact Git tree. No changed-path or bypass argument is
accepted. The check runs unconditionally in App checks before affected-task
selection; the aggregate CI gate requires its raw success outcome. It validates
unchanged dependencies too, so the #169 exceptions cannot outlive their noticed
original. Pending removal paths fail even if their payload is unrecognized.

The guard refuses new unapproved payloads, unsupported/malformed containers and
unsafe members. Encoded/double-encoded JSON, base64 source maps and nested
archives share the same decoder. Dispositions stay exact hash-bound decisions;
no source-provided synthetic marker grants permission. The existing full-tree
inventory remains immutable; new verification receipts append alongside it.

The step 2 count of 136 focused tests comprises 37 new #261 cases (23 scanner/
inventory, 14 reference/audit) and 99 existing regression cases. Four directly
consume committed evidence/policy; 132 use synthetic or mixed fixtures. They
exercise failure/boundary behavior, not 136 independent empirical qualifications.
Step 3 adds real-tree and real-#169 guard checks as well as synthetic refusal
controls and CI-wiring coverage. Private-byte audits remain separate local
evidence and never silently run in public CI.

`step-3-publication-guard.json` records the complete candidate-tree scan,
validation counts and three targeted test mutations. All 136 step 2 cases stay;
nine guard cases are new. The strengthened controls check named refusal reasons,
two-member retention and an actually approving but uncommitted policy edit.
The mutations used disposable source copies and did not change the permanent
auditors. They validate the three identified weak cases, without claiming a
suite-wide mutation score. The candidate scan uses a disposable Git snapshot of
the pending files, not an implementation commit in the owner-reviewed branch.

#256 remains the qualified rights review, separate from this technical scan.
