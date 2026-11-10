# #168 evidence

Step 0 behavior/work evidence qualifies the handler/connection-owner contract,
not final capacity. The final three-cold/three-warm benchmark runs only after its
measured source files are committed. #167 evidence is unchanged history.

Node 24 public audit, no database, cache, private store or node_modules required:

```sh
node services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit docs/evidence/feature-store-168
```

The auditor checks available bytes before parsing and checks exact safe bundle
membership. Since #261, the final benchmark and Step 1 archive use private
references and minimal public projections; the two Step 0 records still use
their committed full bytes. Public output labels those capabilities explicitly.
The new
CI evidence controls also reject incorrect disposal, hidden connections, missing
probes and a disabled server timeout. No live or recorded latency assertion runs
in these Step 0 CI checks.

Detailed bytes were first retained through the local ObjectStore at the audits/
addresses pinned by each receipt; the deterministic USTAR/gzip -n bundle is an
exact durable mirror. Sorted entries use fixed timestamps, uid/gid and modes.
Uncompressed member hashes/sizes stay in each receipt. Reruns add new files and
produce new hashes rather than replacing prior evidence. The approved in-tree
mirror was the qualification-time exception to ObjectStore-only detailed storage.
#261 removes exactly the two selected forecast archives going forward after
durable private retention and readback. Their compact receipts are unchanged.
The owner accepted existing history exposure; no history rewrite took place.

The new `.reference.json` files pin private archive/member hashes and sizes and
the `.public.json` projections. New per-sample projection fields are response
hash, byte size, status/refusal and timings only. Public checks recompute the
available schedule/work/phase/percentile metadata; they cannot verify private
forecast/context linkage, raw SQL-oracle counters or private validation logs.
The safe Step 0 behavior checks still recompute their full original records.

To reproduce the complete original audit, pass the owner's retained ObjectStore
explicitly (its directory is not discovered from environment or receipts):

```sh
node services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit-private \
  docs/evidence/feature-store-168 "$PRIVATE_OBJECTSTORE"
```

Missing private bytes fail this operation. [#261 evidence](../feature-store-261/README.md)
records retention/readback and public/private audit parity.

| Record | Scope | SHA-256 |
| --- | --- | --- |
| step-0/handler-full.json | 16 behavior probes; 30 all-n/lineage success controls, 2P/prefix budgets, matched database work, model-only compatibility and late-delivery refusals | `5ade4ce2a78a87c0ba6c65ff9795066003ab37b364db13b90cd2392e316d62f0` |
| step-0/owner-full.json | 6 real owner controls: standalone/pool 3/2/1, exactly-once discard, query-only handler, delayed disposal/server timeout, pre-I/O refusal, failed-auth cleanup | `f7520d98446ec507dafe8e61fc167f7dc0ca27b7d5e42f478384519875cc28b5` |

Receipts pin the measured SQL/TypeScript SHA-256 and git blob IDs, including
uncommitted Step 0 bytes. These behavior records do not substitute for final
benchmark source/HEAD pinning.

The owner helper's unit controls additionally cover acquisition consuming the
same deadline, late/failed acquisition, immutable request capture, wrong-clock
deadlines, abort at every SQL stage and hung/rejected close handshakes. The
database controls observe that no later query follows interruption, without
claiming immediate backend cessation. The server statement_timeout is ≤300 ms
from statement arrival; immediate owner disposal plus that fallback is the
approved policy.
