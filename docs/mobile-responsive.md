Owner-approved roadmap — 2026-10-18

## Design basis
Pattern: mobile-first responsive reflow using existing Tailwind components, with local scrolling for two-dimensional tables.
Alternatives rejected: separate mobile component trees duplicate behavior; prop-card conversion overlaps #104. Overflow masking conceals inaccessible content.
Assumptions: existing App Router, Zustand selector hooks, Vercel, unchanged REST/SSE/auth contracts. No new backend or performance hot path. Installed Next.js CSS, manifest and viewport guides read.
Discovery: origin/main 20b712c; 32 px shell padding, intrinsically wide prop tables, connection status absent during loading/error. No performance-sensitive path proposed; layout/accessibility measurements pending implementation, no passing results claimed.

## Atomic steps
Verify each surface and obtain owner approval before committing it separately:
1. Shell/status: 16 px gutters at 375 px; compact persistent connection dot plus short label through loading/error/scrolling, avoiding a full sticky banner.
2. Slate controls: wrap controls and labels without page-level overflow.
3. Prop results: labeled keyboard-focusable table scroll regions, visible focus and sticky first column. Local horizontal table scrolling allowed.
4. Bookmaker sheet: contain table overflow and adapt touch controls.
5. Stepper: reflow without clipped labels.
6. Matchup/tracker: wrap content while retaining valid values, stale/as-of flags and visible “sample data” coverage labels.
7. Account: adapt phone layout and controls.
8. Admin: minimal usability changes and no page-level horizontal scrolling.
9. Manifest/icons: EdgeTrace, standalone display, start URL, theme/background colors, regular 192/512 px icons, Android maskable variant and Apple touch icon. themeColor belongs in the viewport export.
10. Verification/evidence: fixtures or isolated mocked responses for populated checks and screenshots, zero Odds API credits. Verify 360, 375, 390, 430, 768 and 1440 px widths; include phone/desktop screenshots in PR. Run relevant tests, lint, typecheck, production build and whitespace checks.

## Targets and reasons
- 375 px: 16 px outer gutters, no page-level horizontal scrolling; local table scrolling allowed.
- Interactive targets >=44x44 px, including chip/checkbox labels: deliberate product choice stricter than WCAG AA to improve touch usability.
- Mobile Lighthouse accessibility >=90 on main and account pages. Account audited with DevTools Lighthouse in a signed-in Chrome profile; record Chrome version, route, authenticated state, settings and results. Admin gets usability/no-page-overflow check.
- Validate manifest and installation in current Chrome; record version/results separately from Lighthouse accessibility (legacy PWA category removed).
- Exercise populated, long-content, stale/disconnected and loading/error states.
- Selector-only Zustand reads prevent broad subscriptions. Persistent connection status and stale/as-of flags prevent misleading freshness. Retaining once-valid values prevents information loss. Visible “sample data” labels prevent mocked coverage appearing real.
- Fixtures/mocks preserve free-tier credits. Exclude src/lib/featureStore, src/lib/predictive, db/ and CI to avoid collisions with another session.
- No service worker, offline support, push, webview wrapper or Expo work, preserving approved web-first scope.

## Workflow
Owner creates feature/dfsEV-136-mobile-responsive from freshly fetched origin/main; no implementation on reference-only #106 branch. One surface per owner-approved atomic commit. Owner runs Codex review, gives fresh consent per push and merges. No attribution trailers. Issue stays open until merge; PR uses Closes #136.
After owner merges #136, repeat triage/roadmap approval for #104 on feature/dfsEV-104-declutter-slate-browser from fresh origin/main. #104 owns selection collapse, per-side Watch redesign and card layouts.

## Shell/status iteration evidence

- In-app browser, fixture-only local server: 375x812 and 1440x900 main page; shared account shell also inspected without available sign-in.
- At 375 px: header left edge 16 px; document scroll width 375 px. After expanding fixture game selection and scrolling 107.5 px, status top remained 8 px. At desktop, document scroll width matched 1440 px.
- Screenshots: [phone](screenshots/136/shell-phone-375.jpg), [desktop](screenshots/136/shell-desktop-1440.jpg).
- Nine focused tests passed (page, auth menu, status while account data is loading/failed); TypeScript, changed-file ESLint and whitespace checks passed.
- Local Firebase sign-in was unavailable; authenticated account and menu dimensions in-browser remain pending. Lighthouse/installability and all remaining surface checks are pending.
