# #224 WAF rule — written activation draft

This is an owner-approved policy draft, not an installed rule or a claim about current plan entitlement. No API, executable manifest or mock rule tests are included. Activation requires separate owner consent.

| Field | Proposed configuration |
| --- | --- |
| Scope | Every path on the production hosts explicitly named by the owner at activation |
| Key | Platform-authoritative client IP |
| Rule count | One per-IP rule |
| Window and limit | 120 requests per 60 seconds, fixed window |
| Initial action | Log-only |
| Enforced action | HTTP 429 |
| Exceptions | None in this draft; any exception changes the reviewed policy |

Do not guess hostnames: covering the wrong host either leaves a bypass or affects unrelated traffic. Count all paths, including assets, sign-in, discovery, stream reconnects, cron and health, because a path exclusion could create a bypass. Shared NAT users share the network allowance; this is a coarse edge backstop, separate from the paid-leader user/network limiter.

## Activation gates

The owner records the exact production host list and verifies in the actual platform dashboard:

- Hobby entitlement supports the proposed window, IP key, scope, log-only and 429 actions, and an available rule slot.
- The allowance amount, reset boundary, counting scope, exhaustion behavior and resulting cost or protection change are understood and accepted. If any behavior is unknown or differs from the approved plan, stop and return the discrepancy to the owner.
- The control for returning this rule to log-only is available and its effect on existing configuration is known. Do not substitute a challenge or another action for 429.

These are release gates rather than assumptions about today's platform offering. The preparation work does not inspect or change a hosted dashboard.

After at least 24 real hours of observation plus the runbook's synthetic journeys, the owner reviews would-block counts and NAT/assets/auth effects. Label 120/60s provisional because low traffic cannot prove a safe production threshold. Switch only this WAF axis with its own approval and retain an independently executable rollback to log-only. App enforcement does not imply WAF approval, or vice versa.
