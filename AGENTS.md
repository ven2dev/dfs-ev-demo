<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project engineering standards

These rules apply to every agent and every checkout. They exist because a
design that was correct but was not the right pattern (#118's training reads)
was only found to be too slow after 20 migrations had been frozen.

## Architecture standard

Use the established industry pattern for the problem. Before building any new
subsystem, data flow, lock, cache, table family or migration series, name that
pattern. Any deviation is a decision for the owner, flagged before code is
written.

## Feature design docs

Every feature or issue design doc (the existing per-feature `docs/*.md`)
includes a **Design basis** section, written and reviewed before
implementation starts:

- **Pattern:** the standard approach for this problem and whether we follow it.
- **Alternatives:** at least two other options and why each was rejected.
- **Targets:** the scale and latency the design must meet (copied from the issue).
- **Requirement reasons:** every hard rule ("must", "never", "always") states
  the risk it prevents. A rule without a reason may be challenged.
- **Assumptions:** the scale, hosting model and threat model the design depends on.

The issue's roadmap comment includes the Design basis and the spike results.

## Acceptance criteria and measurement

Any ticket touching a read path, write path, job or query includes measurable
targets (for example "seal 256 examples in ≤ 5 s with ≥ 30% deadline headroom")
and names the fixture they are measured on.

1. **Spike before approval.** Prototype the hot path at target scale before
   the roadmap is approved. Proposal SQL lives in `db/proposals/`, outside the
   ordered migration chain. If the spike misses a target, the design changes
   or the owner decides. Targets are never quietly relaxed.
2. **Freeze only after proof.** A migration moves into `db/migrations/`, where
   it is immutable, only after its spike benchmark and behavior tests pass.
3. **Two measurement tiers:**
   - **Work budgets (CI, every PR):** deterministic counts that do not depend
     on machine speed, such as SQL statements per request, buffer hits and
     verification calls (for example "rights checked once per request", "each
     file verified once"). They fail when a budget is exceeded.
   - **Speed benchmark (opt-in, at spike and before PR):** real elapsed time at
     target scale, run interleaved against the baseline, passing only with
     ≥ 30% headroom across repeated runs. Evidence JSON is committed. Wall-clock
     assertions do not run in CI.

## Review guidelines

Review the premise before the code:

1. Is this the right pattern for this operation? What would an experienced
   engineer do instead? Say so plainly if it is not best practice.
2. Do the Design basis targets and requirement reasons hold, and are they
   measured?
3. Only then: correctness, tests and style.

Report a wrong-pattern finding even when the implementation is correct.
