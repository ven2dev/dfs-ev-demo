# #167 Step 0 — carried #233 corrections

Step 0 fixes the existing #231 proposal and reader before #167's handler work.
The [approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/167#issuecomment-6622004321)
records the Design basis, the three carried fixes and independent helper issue
#235. No handler, migration or new authorization implementation is included.

## Behavior and work

- All three context functions pin `TimeZone='UTC'`. Resolution on a real LOGIN
  under America/Los_Angeles, Q1 under Asia/Tokyo and Q2 under America/New_York
  preserve feature identity and freshness timestamps. Distinct observations may
  advance; their rendering is canonical UTC. Caller session zones are restored.
- Missing or JSON-null `feature.featureId` raises P2317 at both guard modes.
  Genuine pruning still raises P1666, including when an older valid value survives.
- SQLSTATEs 22007–22009 use the context request error only for resolver/scoped
  reads. Model-only reads retain #166's mapper, which passes unrelated date errors
  through unchanged. Recognized P166x errors retain governance types. Tests mutate
  the original request to prove the captured scope chooses the mapper.
- Every available n=2–16 context probe retains **3 SQL / 2 combined checks /
  1 descriptor GET**, and **2P** actual rights calls for an independently derived
  union profile count P. Model-only reads retain **2 SQL**. Matched n=2/16 server
  work, negative controls and no-lock/deletion proofs remain in the composite record.

These are **behavior/work receipts**, not a speed result. #231's timing evidence
remains historical proof of its exact older sources. #167 still requires the final
actual-handler p95 ≤210 ms / ≥30% headroom benchmark after #235 merges; no second
spike or machine-speed CI assertion is introduced here.

## Append-only receipts and full records

Run ID: `20261104T0352Z`. Fresh filenames retain the earlier #166/#231 receipts
and bundles unchanged. Later runs also use new names; none overwrite these files.

| Receipt | Full member | Purpose |
| --- | --- | --- |
| [Context](step-0-context-20261104T0352Z.json) | behavior bundle: `step-0/full-context.json` | Six resolver/PIT/role/work probe groups. |
| [Composite (corrected label)](step-0-composite-relabel-20261104T0459Z.json) | relabel bundle: `step-0/full-composite-relabelled.json` | Issue 167 / Step 0; fifteen probe groups, cross-zone proof, malformed/pruned references, 79 measured delivery budgets and model-only compatibility. |
| [Composite (original)](step-0-composite-20261104T0352Z.json) | behavior bundle: `step-0/full-composite.json` | Historical source of the corrected-label record; its issue 231 / step 2 harness labels are superseded. |
| [Validation](step-0-validation-20261104T0352Z.json) | validation bundle: `step-0/full-validation.json` | Exact base/corrected source blobs, commands, exit codes, output references and limits. |
| [Supersession](step-0-supersession-20261104T0352Z.json) | validation bundle: `step-0/full-supersession.json` | New behavior records supersede older behavior receipts for corrected sources; no historical bytes or speed result replaced. |

Bundles are `step-0-full-records-20261104T0352Z-behavior.tar.gz` and
`step-0-full-records-20261104T0352Z-validation.tar.gz`. They contain exactly the
named records plus ten validation output logs. Sorted regular USTAR members have
fixed uid/gid/mtime, mode 0644 and empty owner names; gzip uses `-n`. Log output
replaces only the checkout prefix with `<worktree>`; the validation record retains
both original and normalized output hashes. No executable scratch copy is retained.

The append-only correction `step-0-full-records-relabel-20261104T0459Z.tar.gz`
contains the composite record with its issue/step labels corrected and a
hash-bound reference to the original. Every measured value and source hash is
unchanged; this is a metadata correction, not a rerun or a new performance claim.
The auditor applies the same composite work-budget checks to both labels, and a
database-free regression compares all measured fields with the original record.
The original receipts and bundles remain byte-for-byte unchanged.

## Audit without dependencies, cache or database

With Node 24 and tar:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit \
  docs/evidence/feature-store-167
```

The TypeScript tool checks uncompressed SHA-256 and size before parsing or
recomputation. It recomputes all compact projections, all-n/dynamic rights
budgets and matched-work assertions. Detailed cross-zone/refusal outcomes and
command results are hash-bound recorded assertions; audit does not rerun SQL.
Every referenced output log is also checked. Absolute/unsafe/missing/unreferenced
members refuse. Multiple uniquely named bundles permit append-only evidence.
The same command passed in a minimal copy without node_modules or a cache.

Database-free CI checks all references/hashes and exercises tampering, path and
membership refusals. It imposes no live or recorded timing assertion:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test \
  services/pipeline/tests/feature-store/artifact-evidence.check.mts \
  services/pipeline/tests/feature-store/composite-evidence.check.mts
```

## Source identity and validation

Base commit: `da5e502875418684a5e8773059e57d908872a0ae`; Git object format: SHA-1.
The validation receipt records full old/new blob IDs and content SHA-256 for SQL,
runtime TypeScript and changed tests/tooling. Corrected blobs use `git hash-object`
without `-w`; the candidate was uncommitted when measured.

| Source | Base blob | Corrected blob |
| --- | --- | --- |
| `231_composite_authorization.sql` | `d06cfcd8a6dd78722e985cc83655f61641d2e217` | `1b76bbadad364ea557f336ba2ee0239d6844e5dc` |
| `modelArtifacts.ts` | `076d5e4ec701467982103aa2624d477e42efb82b` | `3857fb0480243fac7578a2dcf66cf027f26b5e1f` |
| `modelContext.ts` (unchanged) | `f6df312d6e376c6c9d9d7fdecd671ba16db84cde` | `f6df312d6e376c6c9d9d7fdecd671ba16db84cde` |

Node 24.18.1; registered loopback PostgreSQL 18.6; 512 MiB data tmpfs and 128 MiB
shared memory. The final full feature-store run passes **217 checks**, including
all four #229 files; **1,254 unit tests**, typecheck, lint and **12 database-free
evidence checks** pass. Historical #166/#231 audits pass. Frozen migrations and
earlier evidence are unchanged.

The record retains an unleased full-suite attempt interrupted by an administrator
disconnect during concurrent local testing (212 passed, 4 failed, 1 cancelled).
It is not reported as a pass. The subsequent final suite held the existing
disposable-test session lease (namespace 153045) without a startup sweep and
passed all 217 checks. First sandbox attempts refused loopback connections/binds;
successful runs used local loopback permission. The receipt gives commands and
outputs. This is local fixture validation, with no hosted or Production access.

Behavior reruns use fresh `FS231_CONTEXT_EVIDENCE` and
`FS231_COMPOSITE_EVIDENCE` paths; writers refuse to clobber a prior file. A rerun
produces different IDs/clocks and a new record hash. Compact and bundle those
exact bytes under new names, retain source identity, then run the audit again.

During later full-suite runs, retain and report any `artifact-cleaner.check.mts`
failure output before retrying; a later pass does not replace that output.
