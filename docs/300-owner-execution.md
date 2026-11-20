# #300 owner execution sheet — review draft

**OWNER ONLY. Never-merge; no PR.** Requires reviewed commit, separate push permission and hosted approval. Node 24.18.1. Friday 2026-11-20, START–START+4h Pacific (fill START). If not reviewed Thursday evening, propose Monday 2026-11-23.

**Limits:** $3 total; 40,000 invocations; delete/verify absence by **D=min(START+6h, first resource+6h)**. Begin teardown by D−1h. Stop new qualification at START+4h. Resources: `vernon-ven2dev`; `dfs-ev-300-single` PS-5 single / `dfs-ev-300-ha` PS-5 HA; PG18, AWS us-east-1; protected Vercel iad1 Previews; isolated HA branch `dfs-ev-300-ha-restore`.

Prepare [private input](300-owner-input.md) outside Git: directory 700, file 600. Confirm live all-in quote, CPU/memory/transfer headroom, and **used + background + 40,000 <= allowance − 100,000**. Check quote/quota observations (no older than 15 minutes) at session open, before `matrix` and before `incident` only. No mid-matrix edits are required; deadline/expiry/window checks remain per request. Values stay in the private editor/password manager, never command arguments/chat.

Open one session from the clean reviewed commit (substitute paths only):

```sh
caffeinate -i node scripts/spikes/300-owner-runner.mjs --approved --private /ABS/PRIVATE/inputs.json --out /ABS/PRIVATE/NEW-EVIDENCE
```

**Keep this terminal open until `close`; closing it ends the session with no resume.** Type these one-shot commands in that session. Console actions remain manual; no programming is needed during the window. Success prints `passed`, step and reservation count. **Any STOP: end qualification and perform teardown.** No retry/resume; preserve failed evidence and `.session-claim`. EOF/crash closes the session. Ctrl-C/SIGTERM drains the in-flight wave before stopping.

| Owner action / condition | Command | Expected result / stop signal |
| --- | --- | --- |
| Provision exact S/H; record IDs, T0/D, verified bindings and private DSNs. | `setup` | Two fixtures, unchanged setup/grants/defaults. SQL refusal: STOP. |
| Generate settings, then load six branch-scoped Secret variables; create immutable VS/VH, verify builds/protection/metadata and enter deployment records. | `delivery` | Two private `<SHA>-delivery` files; no values printed. |
| Retire pre-change backends; record reset/lifetime-wait evidence and actual pool sizes. Recheck headroom. | `matrix` | Exact #220 held-transaction gate once/arm, 92 groups / 37,006 samples. Any timeout mismatch, incomplete coverage, failed sample or full-path p95 >63 ms: STOP. |
| After clean screen, capture paused HA/sentinel manifest; wait for selectable clean point and record it privately. | `source` | Manifest saved; no active leases. |
| Before incident access/navigation or restore work. | `incident` | Monotonic + UTC clock starts. |
| Request exact R in console; record actual selected point/acceptance. | `requested` | Local request milestone; provider metadata remains separate. |
| Observe Ready; reset/deliver credentials, reinstall required extensions, enter distinct R binding. | `ready` | Clock continues through all owner work. |
| Verify source-before / restore / source-after. | `verify` | Logical parity, then fresh recovery run/tickets. Mismatch: STOP. |
| Generate/load R settings; deploy immutable VR and record metadata. | `restore-delivery` | Private recovery delivery file; clock continues. |
| Send one new authenticated service sample. | `recovery` | Automatically reserved; inherited identity/work assertions; <=4h elapsed result. No retry. |
| Delete VR/VH/VS/aliases; attest control-plane deletion and backend quiescence. | `availability` | Up to three automatically reserved checks; 404/410 required. Failure stays counted; continue console cleanup. |
| Delete R/H/S/optional backup; remove variable IDs/bypass; verify exact IDs and billable compute absent. | `close` | Final ledger total; clear live input/delivery credentials, retain private evidence. |

No manual ledger appends. Clean sequence reserves **37,010** (gate uses direct SQL). Benchmark bypasses proxy; unexpected invocation multiplicity stops before traffic. HTTP unavailability supplements provider inventory; it cannot prove deletion. Record UTC lifetimes, absence evidence and delayed billing; unresolved absence remains open. No Production changes, provisioning, hosted traffic or push is authorized by this draft.
