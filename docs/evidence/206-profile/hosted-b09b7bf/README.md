# Hosted finite qualification evidence for b09b7bf

Copied unchanged from the operator's off-repository evidence folder after
independent read-only review. Reviewed SHA:
b09b7bfca7c5322a37a348238b42f5f98e3a6560. Disposable Preview:
`dpl_8xTy1wrYE8DiRJdHKFyZgBgByknC` (deleted).

| File | Contents | SHA-256 |
| --- | --- | --- |
| `hosted-report.md` | Operator report: identity, outcome, sequence, cleanup | `2971b32a40d535ca359a1212393d870d364e0f258120cc08da85ff3d2575682d` |
| `functional-results.json` | The five HTTP responses: catalog 503, setup, catalog, qualify, cleanup | `c0131c6fd6c3bda80d70b1f750da5be531973438dcf761f8d9ffcc87c3a1a0c6` |
| `cleanup-receipt.json` | Deployment absence and URL 404 checks | `60aed94a2d49487f7eb6ed5561a7c94248f721c42a3cede25145e3848ddfa9a6` |
| `residual-sessions.json` | Two idle sessions for the dropped role, at two observations | `40c204b1511f4976db16fdb35daf546be81f3b269eb49cb8188ca286fd5268ac` |

Known limits, recorded in `docs/verification/61-http-timeout-qualification.md`
("Hosted qualification review after b09b7bf"):

- None of the JSON files records observation times. The residual-sessions
  follow-up does not record how long the wait was, and the cleanup receipt does not
  record when deletion and the URL 404s were checked.
- `functional-results.json` does not name the deployment id; only the report links
  it to the Preview above.
- The report's "backend isolation held" claim is narrower than written: the probe
  shows transaction-local state did not carry over, which PostgreSQL guarantees at
  commit regardless of pooling.
- Residual sessions: do not claim zero until a timestamped observation shows them
  gone.

Not committed: browser accessibility captures and screenshots, which the report
names as secondary to the structured JSON. No credential, token or connection URL
appears in these files. The owner fingerprint is a SHA-256 of a benchmark token that
no longer exists, and the endpoint hostname is already in `bench61-config.json`.
