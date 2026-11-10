# Published evidence payload inventory (#261)

The owner approved removal going forward of three #168/#242 archives, with
their existing exposure in public Git history accepted. Two #169 archives stay:
their only payload finding is an exact encoded copy of the already-noticed #138
ingestion receipt. [The recorded decision](https://github.com/ven2dev/dfs-ev-demo/issues/261#issuecomment-6759765086)
binds those copies to the original and to each archive's complete hash. #169's
auditor and CI check keep their existing behavior.

## Design basis

**Pattern.** A content-addressed artifact inventory with explicit dispositions
and separate public and private audit capabilities. One bounded decoder serves
the complete rescan and the publication guard. Existing ObjectStore storage and
evidence auditors supply private retention and verification. The inventory
records technical findings; it does not decide copyright or legal lineage.

**Alternatives.** Rewriting public history was rejected by the owner: it breaks
clones and references and cannot revoke fetched copies. Keeping the three
forecast archives with a new notice contradicts their explicit removal
decision; #256 supplies no current publication clearance. Deleting archives
and skipping missing-file checks would lose evidence assurance. A hash-only
receipt cannot verify unseen forecast values. Raw-text searches miss encoded
JSON and source maps; separate decoders would reproduce the drift that caused
the original inventory gap.

**Targets.** At main `f30b93f23a30316213f07ba346e4a301550d57b0`, cover all
901 tracked paths, 33 compressed files and 360 leaf archive members. Enumerate
every file/member's hash and size, and each tracked path's Git blob and
introduction at its current path. Preserve measured results, source identities,
the #168 v1 and #242 v2 rules and all failures. Produce no new unapproved
payload. CI enforces content/disposition and recorded arithmetic, with no
wall-clock assertions or new capacity run.

The disposable intake pass found 1,530 encoded JSON strings and 154 base64
source files in about 212.2 MB of expanded containers. It took 12.213 s on this
host; this is a scanner observation, not a capacity qualification. Seven
controls exercised structured JSON, encoded and double-encoded JSON, log
fragments, source maps, nested archives and timing-only negatives. Offline
baseline audits passed #168's 32, #242's 24 and #169's 44 records on Node 24.

**Requirement reasons.**

- Exact private bytes are retained through ObjectStore and read back before
  deletion, preventing evidence loss or substitution. References contain only a
  store-relative key, SHA-256 and byte size, preventing disclosure of local paths.
- Retention uses the owner's durable private store, outside disposable briefs;
  directory mode 0700 prevents access by other local users. No retained object
  belongs under `codex-briefs/`, because that folder is archived and cleared.
- The owner accepted history exposure; no rewrite or force-push avoids clone
  disruption while acknowledging copies already fetched.
- Recursive decoding includes JSON strings, fragments and declared base64 source
  maps, preventing the known alternate-encoding bypass. It does not extract
  archive members. Limits and refusal of malformed, unsupported, unsafe or
  duplicate members prevent resource exhaustion and incomplete success reports.
- Dispositions bind exact paths and hashes, preventing path-only approval of
  changed bytes or a new delivery surface. #169 copies also require the exact
  original #138 file to remain approved; removal or hold of that original
  withdraws approval for its copies.
- #197's inventory stays unchanged; a new append-only inventory preserves the
  historical scan gap rather than rewriting it.
- Public projections contain only per-sample hash, byte size, status/refusal and
  timing. No player/game identifier exception is currently approved; adding one
  requires a named public check and justification here, preventing unnecessary
  publication of governed context.
- Public audits state their limited capability. They recompute safe timing,
  status and work metadata from receipts/projections, preventing false claims
  about private forecast values. Only an explicitly supplied private-byte audit
  reproduces the original full-record verdicts.
- No database lane, hosted write, Production command, frozen migration or new
  model/producer timing run is needed for this offline boundary; excluding them
  prevents operational risk and accidental changes to measured sources.
- Each step stops for commit approval and a push needs fresh consent, preserving
  owner review. Attribution lines are excluded under the repository's Git rule.

**Assumptions.** A trusted local operator, exact Git objects and retained local
ObjectStore bytes; a public repository whose history remains accessible. The
threat model is ordinary research evidence in text/containers, not image OCR,
steganography, encryption or adversarial legal-lineage concealment. PNG/ICO
assets are enumerated and hashed; unknown binary/container formats are refused.
Supported archive formats are gzip and regular-file USTAR (including nested
combinations); other formats fail closed for review. Detection is heuristic:
manual classification and explicit, hash-bound dispositions supply its policy
boundary. A claimed synthetic marker grants no exemption. Qualified rights
review remains with #197/#256. An exact-copy exception does not approve changed
source bytes or another archive/hash.

## Decisions and audit boundary

The three owner-selected #168/#242 archives are removed only after verified
retention. Their compact original receipts remain where possible, alongside new
versioned references/projections. Public metadata checks are not described as
full audits. Private audits hash the original archive and members and invoke the
existing original record verifiers. No synthetic forecast is constructed to
satisfy a verifier. Private bytes being unavailable is not a full-audit pass.

Both #169 archives stay publicly at their approved hashes, under the narrow
extension of [the #138 notice](evidence/feature-store-138/NOTICE.participation.md).
If that original is removed or held, its copies go with it. A new finding returns
to the owner. No legal permission is inferred from a scanner match or absence.

## Approved sequence

1. Shared scanner, tests, full pinned-tree inventory and the narrow #169 notice.
2. Verified private retention, references/projections, common audit resolution
   and removal of exactly the three selected archives.
3. Always-executed CI guard, evidence audits, documentation and review handoff.

The approved estimate is 3–4 active hours including intake, with no #169
conversion. If projected work exceeds five hours or another data class/consumer
appears, work stops for a scope decision.
