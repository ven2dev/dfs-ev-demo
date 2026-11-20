# #223 C3 acceptance addendum — draft for owner review

Before any enforcement activation, #221 shared-cache capability must select
shared on every serving instance, old legacy instances must be drained, #299
must provide verified live-user transport, and #224 requires separate owner
activation. This prevents a denied legacy in-flight creator from passing its
refusal to otherwise eligible joiners. Legacy or unavailable shared-cache
capability downgrades any requested enforce mode to log-only for discovery and
live. Regression tests prove the SQL receives enforce=false and no deny-cache
entry is inserted. No enforcement is enabled by #223.

The authenticated top-consumers API exposes only versioned HMAC subjects,
fixed approximate 1h/24h windows, traffic/dimension totals and top-20 admissions,
denials and would-denials in one aggregate statement. Counts are subject-
dimension admissions to send, not exact unique network sends. The existing
health bearer protects it; unauthorized requests perform zero database work.
Retention is an inactive 7-day proposal with bounded 1,000-row batches and
protection for future TAT, recent rotation state and referenced subjects.
Health thresholds remain inactive owner-policy proposals (100 warning / 500
critical admissions or denials/would-denials per subject/hour). Report errors
are unavailable with reason-only diagnostics. No issue edits are posted here.
