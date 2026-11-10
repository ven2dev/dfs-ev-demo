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

This step does not remove or privately retain any archive. Subsequent steps add
the verified ObjectStore references, minimal projections and public/private
audit resolution, then wire the shared scanner into an always-executed CI
check. Public metadata checks will not claim to verify unseen forecast values;
only a private-byte audit reproduces those original full-record verdicts.
#256 remains the qualified rights review, separate from this technical scan.
