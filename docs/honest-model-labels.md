# Honest interim estimate labels (#135)

Status: roadmap approved by Vernon on 2026-10-16; implementation awaiting review.
Both clarifications were approved: small-sample labels on all 3/5/7-game results,
low-confidence labels at the extremes, and retention of the same prop's last
valid result while refreshing. Vernon also requested color-coded freshness.

## Design basis

- **Pattern:** explicit data provenance and uncertainty labeling; retain the last
  successful snapshot while revalidating, with visible freshness. Use the existing
  keyed Zustand snapshot and EventSource lifecycle. No new cache or fetch path.
- **Alternatives:** blank values while loading was rejected because the owner
  wants continuity; retaining values without their original sample metadata was
  rejected because it mislabels an old result as the newly requested window;
  replacing the stream with a caching library adds unrelated fetch behavior.
- **Targets:** #135 specifies no latency target and no new read/write path. Work
  budget: zero additional database queries or provider calls, unchanged polling
  and model arithmetic. Only metadata already known to the current stream is
  added to its existing tick. No new hot-path spike or migration is applicable.
- **Requirement reasons:** show actual games counted rather than the requested
  maximum to avoid overstating evidence. Keep snapshot, sample, timestamp and
  source together to prevent mixed-window results. Reject callbacks from retired
  streams so a late response cannot replace the current selection. Never move
  a result across prop identities because it would attribute another player's
  evidence incorrectly. Keep text alongside color for accessibility. No numeric
  confidence score is invented because these samples are uncalibrated.
- **Assumptions:** the existing responsive web client, trusted same-origin tick
  payload, one active watched stream, 3/5/7-game requested windows, and current
  account isolation. Retained results stay in the current account's existing
  in-memory keyed state; this does not add offline storage or a historical cache.

## Approved steps

1. Carry actual sample size and requested sample window in each existing tick.
   Name the raw result recent hit rate. Name adjusted results illustrative and
   uncalibrated; mark every coverage-derived surface as sample data.
2. Show Small sample on all supported windows and Low confidence when a raw
   hit rate or displayed adjusted estimate is 0% or 100%.
3. Retain the same prop's last valid snapshot while updating. Preserve its own
   window, count, line, source and timestamp. Amber means stale/updating/paused;
   red means a failed update. Keep the number readable and pair color with text.
   The chosen window can change immediately; the retained number's label cannot.
4. Fix watch rollback copy and the obsolete DATABASE_URL mock-fallback comment.
5. Run focused component, stream-hook and stream-route tests, typecheck and lint.
   No hosted commands, predictive branch edits, database writes or migrations.

## Freshness display

Example after changing Last 5 to Last 3: retain 60% with n = 5 games; display
an amber Stale · updating to last 3 games badge and Showing the last valid
5-game window with its original n · Updated [time]. An error changes the badge to red Stale · update
failed. An idle or timed-out feed uses amber Stale · updates paused. A valid new
tick atomically replaces the result and removes the stale badge. Connection open
alone does not make the old result fresh. A never-loaded prop has a waiting state.

## Verification plan

Fixtures cover actual n below the requested window, all 3/5/7 windows, raw and
adjusted 0%/100%, live versus fixture provenance, coverage-derived edge/tracker/
entry displays, window changes, failure/disconnect/idle/timeout, successful
replacement and late old-stream callbacks. Existing computeEV tests protect
unchanged numerical behavior. Existing stream fixtures prove no extra upstream
lookups are introduced; no wall-clock speed benchmark is relevant to copy.

Commit, push and PR creation await the owner's review sequence. No commit or
push approval is inferred from roadmap approval.

## Local verification

- 41 affected Vitest UI/math/lifecycle cases passed, covering sample labels,
  freshness colors/text, retained values, atomic replacement, disconnected/idle/
  timeout states and retired callbacks.
- 20 stream-route cases passed using mocked provider/database dependencies,
  including actual n below every supported requested window and one history/
  provider-input lookup per connection/tick. Existing fixture isolation holds.
- Typecheck, affected-file ESLint and whitespace checks passed.
- No numerical model change, new provider/database request, hosted command,
  migration, commit or push. Independent owner review remains pending.
