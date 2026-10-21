# #200 presentation verification

Verified 2026-10-20 on Node 24.18.1, against commits `9d9a19e` and
`55ac56b`. Parent #53 remains open; this is its presentation slice only.

## Automated checks

- Browser Vitest suite: 70 files, 947 tests passed. The sandbox denied local
  loopback listeners on the first run; the complete rerun with listener access passed.
- SSE server suite: 20 tests passed, including selected-side quote metadata
  without additional upstream fetches.
- Root typecheck, lint (including import-boundary checks), production build,
  and `git diff --check` passed.

## Browser checks

Used `ODDS_DATA_SOURCE=fixture` at `http://localhost:3140/`, with fictional
Avery Stone passing-yards props. No live provider calls or database queries
were required for this fixture verification. These checks used the development
server; the production build was checked separately.

| Viewport width | Document width | Main left/right gutters | Rendered buttons, selects and disclosures below 44×44 |
| ---: | ---: | --- | ---: |
| 360 | 360 | 16 / 16 | 0 |
| 375 | 375 | 16 / 16 | 0 |
| 430 | 430 | 16 / 16 | 0 |
| 768 | 768 | 32 / 32 | 0 |
| 1440 | 1440 | 176 / 176 | 0 |

- Visually checked populated results and observed movement at every width.
  Estimate, Market and Edge remain separate; the stepper and sparkline are gone.
- A second fixture tick displayed the observed decimal-price, consensus and
  edge changes, qualified by the session start time. Its line remained unchanged;
  changed-line and missing/differing-context cases are covered by unit tests.
- Opened and closed Adjustment details using Enter.
- Stopped the local server: the compact connection indicator showed Disconnected,
  results showed “Stale · update failed”, and prior estimates, quote and movement
  remained visible. Restarted the fixture server afterwards.
- Reloaded and selected the same prop again: movement returned to “Collecting
  another observation”, with no observations carried over from the earlier session.
- The page visibly labels fixture/sample observations and the illustrative,
  uncalibrated estimate; edge uses percentage points and is not described as EV.

Screenshots and width measurements stay outside git, in the issue-200-evidence
folder in this chat's local artifact directory. The `movement-<width>.jpg` files
are the populated screenshots intended for PR attachment; additional captures
record keyboard disclosure, disconnect retention and reload behavior.

## Limits

The browser was in dark mode. This is not a new Lighthouse audit or an
authenticated-page verification. Local Firebase sign-in reports an invalid API
key; guest fixture watching was sufficient for this slice. No auth configuration,
database, pipeline, or domain changes were made.
