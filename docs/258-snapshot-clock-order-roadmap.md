# #258 snapshot clock ordering

## Design basis

- **Pattern.** Store host capture time as an observation and use the existing
  foreign key and insert sequence for causal ordering. The job and snapshot
  triggers stamp their own database times.
- **Alternatives.** A database timestamp comparison can reject a valid insert
  after a backward clock step. A cross-clock tolerance still rejects valid
  input outside the tolerance. Database-stamping the capture would substitute
  insertion time for the worker's observation.
- **Targets.** Preserve the 12-statement ingest path, the #169 42 s paired
  ingestion target and 60 s leg deadline, and the 84 s feature target under
  the existing 120 s deadline. Preserve the original fixture and use fresh
  receipts for changed source pins.
- **Requirement reasons.** Capture stays verbatim for auditability. Point-in-time
  selection uses the existing source availability, database ingestion and
  job-completion boundaries. Keep historical receipts with their original
  source identity so earlier measurements stay reproducible.
- **Assumptions.** Trusted restricted writer, disposable local PostgreSQL and
  the exact original wire pins. No Production changes.

## Checkpoints

1. **Behavior.** The owner selected option (b). Remove the cross-clock CHECK.
   The real ingest path accepts ±30 s of reported skew with exact capture
   preservation and 12 SQL statements. The foreign key still refuses missing
   owners. The proposal retains all three #244 restore trigger names. Both
   PostgreSQL suites passed on lane-2 standard. Commit `cad93c9`.
2. **Requalification.** The audited #169 producer matrix passed all 30
   attempts on lane-3 large. The guarded #244 CLI replay passed twice on
   lane-2 large, with separate normalized and derived parity and expected
   missing/corrupt-input refusals. Both lanes were removed after use. See the
   [#258 evidence and archive disposition](evidence/feature-store-258/README.md).

## Pending under #173

The current-source prediction and dataset capacity refreshes remain pending
under [#173](https://github.com/ven2dev/dfs-ev-demo/issues/173). Its prior
attempt stopped in prediction fixture preparation at the 128 MiB temporary
file limit. It produced zero timed prediction samples and the dataset
matrix did not start. Preserve the historical timings and the stopped
attempt. The refreshes need an owner-approved fixture decision before a
new timed run.
