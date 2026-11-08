# Benchmark transfer support (#251)

## Design basis

**Pattern:** one bounded HTTP redirect/body loop with a strict production facade
and an explicitly enabled fixture adapter. The fixture server and runner helpers
live in pipeline script support; production ingestion keeps its existing
downloader dependency seam.

**Alternatives:** a copied benchmark downloader risks protocol/refusal drift. A
general production host override or environment switch widens access and makes
test configuration ambient. Repinning changes #169's approved fixture.
Self-hosting originals measures Cloudflare rather than production's GitHub path;
the existing `edgetrace-fs-test` bucket also permits synthetic bytes only. A web
framework or the creator-review server adds unrelated routes and dependencies.

**Targets:** preserve the 64 MiB wire cap, at most three redirects and default
60 s deadline. Synthetic pinned ingestion uses exactly 12 SQL statements with
one bulk insert and no per-example queries. CI checks behavior and work, not
machine speed. #169 owns the paired ingestion sum <=42 s (each part under 60 s)
and feature qualification <=84 s under 120 s at eight SQL.

**Requirement reasons:** shared transport checks prevent drift; strict production
hosts and pins prevent local-network access or changed bytes entering ingestion;
bounded transfers and identity encoding prevent incomplete, transformed or
oversized responses from qualifying. Explicit fixture origins prevent a general
host bypass. ObjectStore ownership and checked cleanup prevent untracked raw
files and deletion of original fixtures. Failures remain failures without retry
or cached fallback to prevent survivor bias.

**Assumptions:** Node 24, trusted local runner, private ObjectStore and restricted
pipeline credentials. Support tests use synthetic bytes and controlled responses.
No hosted storage or real-source speed qualification occurs in #251. #169's
disposable paired spike is the first real consumer; any needed interface changes
belong in #169's PR rather than a third issue.

## Host access and fixture lifecycle

`downloadSource` retains its signature, receipt shape, GitHub/release-assets
HTTPS allowlist and strict wire-size behavior. `normalizeSource` remains the
owner of pinned SHA-256/provider-digest validation before publication. No extra
production hash pass, producer algorithm or SQL is added.

The internal transport has two closed policies: production and an exact mapped
fixture path on a fixed loopback origin. It is not a new public package export.
`openTransferFixture` requires `{ testOnlyLoopback: true }` explicitly. It binds
`127.0.0.1` on an ephemeral port and supplies a downloader closure scoped to that
actual origin and the registered source URLs. It never changes the original
SourceAsset passed to normalization or saved as provenance. Production calls
cannot enable this policy through an environment setting or extra argument.

The server serves explicit raw ObjectStore mappings, accepts the expected Host,
path and GET/HEAD methods only, and has no generic filesystem/proxy route.
Source reads happen when serving the request. The close handle is idempotent and
closes active sockets; it does not delete source objects. The runner owns its
destination: verify SHA-256/size, delete through ObjectStore, verify absence,
and perform cleanup in a finally path while reporting cleanup failures.

The interface is provisional. #169 owns cold/warm setup accounting, paired
timing arithmetic, attempt journals and durable capacity evidence.

## Validation boundary

The host-access change and production-refusal tests form the first separate
commit and are listed first in the review handoff. Synthetic real HTTP ingestion
is checked on standard-tier lane-3 with the existing 12-SQL budget; wrong pins
and corrupt data fail before publication. No original fixture or evidence is
changed. Node 24 checks exclude `codex-briefs/**`.

Database commands set `DB_TEST_LANE=lane-3`, clear an inherited `DB_TEST_TIER`,
derive the URL through `scripts/db/test-db.mjs url`, preflight before work and
keep ownership through completed teardown. Standard tier is 512 MiB with the
existing 272 MiB admission threshold. No large-tier lane or timing window is
used in #251.

Step 1 validation on Node 24: all 27 focused unit tests pass (20 new fixture/host
checks and seven existing normalization/download checks). Standard lane-3 passes
the three new integration probes and ten existing ingestion probes, with no
skips. Both the one-row and 64-row real HTTP ingestions use exactly 12 SQL;
wrong pins and corrupt gzip issue zero producer SQL. Saved snapshot provenance
retains the original GitHub URL, verified destination raw objects are removed,
and source objects remain intact. Typecheck, lint and all 11 import-boundary
checks pass. The sampled standard mount peak is 72,400,896 bytes (69.047 MiB);
lane teardown and container absence are verified. This is synthetic behavior
and work proof, not #169's capacity qualification.
