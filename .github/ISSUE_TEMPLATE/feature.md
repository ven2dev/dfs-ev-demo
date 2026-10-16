---
name: Feature or change
about: New feature, data path or behavior change
labels: type:feature
---

## Description

<!-- Why this is needed. -->

## Targets

<!-- Required for anything touching a read path, write path, job or query.
     Delete this section only for docs/UI-copy changes. -->

- Scale: <!-- e.g. 256 examples, 64-QB fixture -->
- Latency: <!-- e.g. ≤ 1 s p95 read, ≤ 5 s prepare -->
- Headroom: ≥ 30% under the operation's deadline across interleaved runs
- Work budget: <!-- e.g. one rights query per request; statements flat as rows grow -->
- Fixture: <!-- data set the targets are measured on -->

## Acceptance Criteria

- [ ] Design basis (pattern, alternatives, targets, requirement reasons, assumptions) approved before implementation
- [ ] Spike meets the targets before any migration is frozen (if applicable)
- [ ]

## Non-Goals

-
