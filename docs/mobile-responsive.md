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
- Mobile Lighthouse accessibility >=90 on the main page; record browser version, route, fixture state, settings and results. Authenticated account browser/Lighthouse verification is deferred by owner decision until managed-secret delivery is established (#97–#101); it is not an acceptance gate for #136. Account layout remains in scope using isolated component fixtures. Admin gets usability/no-page-overflow check.
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

## Slate-controls iteration evidence

- Fixture-only populated slate checked at 360, 375, 390, 430, 768 and 1440 px. Document scroll width matched viewport width at every size.
- Game select, market labels and normal-mode toolbar buttons measured at least 44x44 px at all six widths. At 375 px, comparison chips measured 44 px tall, with widths 120–135 px.
- Screenshots: [phone comparison controls](screenshots/136/slate-controls-phone-375.jpg), [desktop comparison controls](screenshots/136/slate-controls-desktop-1440.jpg).
- All 17 existing slate-browser tests passed; changed-file ESLint and whitespace checks passed. This step changes layout only; card/table accessibility and card action sizes belong to the next iteration.

## Prop-results iteration evidence

- Labeled, described and keyboard-focusable scroll regions preserve native table semantics, explicit column/row headings, sticky first columns, and visible focus. Watch and See all targets measure 44 px tall.
- Fixture single and two-book comparison modes checked at 360, 375, 390, 430, 768 and 1440 px: document scroll width equals viewport width in both modes at every size.
- At 375 px, ArrowRight advanced the first table from scrollLeft 0 to 40 and then its 178.5 px end; the row header stayed at the region's left edge and both action buttons were visible at the end.
- Verification found screen-reader-only action heading text escaping the scroll container's positioning context at narrow widths; making the region a positioning context resolved it. Both modes and all widths were rechecked after the fix.
- Screenshots: [phone scrolled to actions](screenshots/136/prop-table-phone-375.jpg), [desktop](screenshots/136/prop-table-desktop-1440.jpg).
- All 28 existing prop-card and slate-browser tests passed; TypeScript, changed-file ESLint and whitespace checks passed. No odds selection/watch logic changed.

## Bookmaker-sheet iteration evidence

- Sheet uses an 80dvh height limit, contained vertical scrolling, bottom safe-area padding, wrapping heading, and a fixed-layout table with wrapping bookmaker names and semantic row/column headers. Close is 44x44 px.
- Fixture sheet checked at 360, 375, 390, 430, 768 and 1440 px. Document scroll width matched each viewport; table scroll width matched its client width at every size (326–396 px). Desktop panel remains capped at 384 px.
- Escape dismissal verified in browser. All five existing sheet tests passed, including Close, backdrop and Escape behavior. TypeScript, changed-file ESLint and whitespace checks passed.
- Screenshots: [phone](screenshots/136/bookmaker-sheet-phone-375.jpg), [desktop](screenshots/136/bookmaker-sheet-desktop-1440.jpg).

## Pipeline-stepper iteration evidence

- Numbered semantic list, with aria-current="step" on the active stage. One column on phones, two at sm, four at lg; wrapping labels and existing tick animation retained.
- Fixture watched prop checked at 360, 375, 390, 430, 768 and 1440 px: no clipped stage items, exactly one current stage, document scroll width equals viewport width at every size.
- Screenshots: [phone](screenshots/136/stepper-phone-375.jpg), [desktop](screenshots/136/stepper-desktop-1440.jpg).
- Four existing page tests passed, including last-valid stale values and fixture/sample provenance; TypeScript, changed-file ESLint and whitespace checks passed. Sample-window buttons and numeric layout remain for the matchup/tracker iteration.

## Matchup/tracker iteration evidence

- Phone section padding reduced to 16 px; long copy wraps. Numeric rows use a flexible label column and a nonwrapping numeric column. Sample-window buttons expose their pressed state and, with the secondary Watch button, measure at least 44x44 px.
- Fixture primary analysis and secondary tracker checked at 360, 375, 390, 430, 768 and 1440 px: document scroll width equals viewport width; no numeric grid overflow; sample-window/secondary controls are 44 px tall at every size.
- Screenshots: [phone matchup](screenshots/136/matchup-phone-375.jpg), [phone tracker](screenshots/136/tracker-phone-375.jpg), [desktop tracker](screenshots/136/tracker-desktop-1440.jpg).
- Existing tests cover preserved last-valid stale/failed values, observation time, original sample count and fixture/sample labels. Rendering and freshness logic unchanged; muted evidence copy contrast improved for light mode.

## Account iteration evidence

- Account fields stack on phones and use a label/value grid on larger screens; long unbroken names wrap. Confirmation actions wrap, all inputs/actions have 44 px minimum height, and the confirmation input has an accessible label. Deletion/auth behavior unchanged.
- Temporary isolated Vite component fixture (outside the repository) renders the actual account component with a fake signed-in identity and an unusually long unbroken display name. No auth bootstrap or credentials; sign-out is inert and auth headers throw, so account operations cannot run.
- Fixture confirmation layout checked at 360, 375, 390, 430, 768 and 1440 px: document width matches viewport; input and buttons are at least 44x44 px. These screenshots are component layout evidence, not authenticated app evidence: [phone](screenshots/136/account-fixture-phone-375.jpg), [desktop](screenshots/136/account-fixture-desktop-1440.jpg).
- Four existing account behavior tests passed; TypeScript, changed-file ESLint and whitespace checks passed. Authenticated account browser/Lighthouse verification is deferred by owner decision until managed-secret delivery is established (#97–#101); it is not an acceptance gate for #136.

## Owner scope amendment — 2026-10-18

Authenticated account browser/Lighthouse verification is removed from #136 acceptance until managed-secret delivery (#97–#101) is established. No local credential setup is required for this UI issue. This is deferred verification, not a passing authenticated result. Account responsive layout stays in scope using isolated component fixtures; the main-page mobile Lighthouse accessibility target remains >=90.

## Admin usability iteration evidence

- Minimal layout-only adaptation: 16 px phone section padding, contained/wrapping long submission names and URLs, wrapping date row, vertical-only textarea resizing, accessible input names and 44 px controls. Authorization, identity/race guards and submission logic unchanged.
- Actual admin component rendered in the temporary isolated fixture with synthetic long names/URLs; GET returns only the local fixture and submission requests throw. No credentials or real creator data used.
- At 360, 375, 390, 430, 768 and 1440 px: document scroll width matches viewport; inputs, textarea, submit and submission link targets are at least 44x44 px.
- Screenshots: [phone](screenshots/136/admin-fixture-phone-375.jpg), [desktop](screenshots/136/admin-fixture-desktop-1440.jpg). These establish component usability, not authenticated deployment verification.

## Manifest/icons iteration evidence

- Added typed Next manifest with EdgeTrace name/short name, root id/start URL/scope, standalone display, and #18181b background/theme. Viewport export supplies theme-color; Next file conventions supply manifest, SVG browser icon and Apple touch icon links. Replaced scaffold favicon.
- Regular PNGs are 192x192 and 512x512; maskable PNG is 512x512, Apple PNG is 180x180. Maskable/Apple files are opaque. Original SVG source is src/app/icon.svg; PNGs generated with installed Sharp. Maskable artwork is within the central 80% safe circle.
- Served /manifest.webmanifest inspected; live DOM links point to the manifest and Apple icon and expose the expected theme color. No service worker or offline code added.
- TypeScript, changed-file ESLint and whitespace checks passed. Preliminary mobile Lighthouse 13.5.0 / HeadlessChrome 155 accessibility audit on the development main page scored 95. It identified contrast failures for existing muted/error text; final production/populated-state audit remains pending.
- Native Chrome access was not approved, so Chrome UI installability/actual installation remains unverified. No claim that the Chrome installability target has passed.

## Final verification

- Manifest/icons committed as 3dfcace; owner-approved lowercase e applied to SVG, regular PNGs, opaque maskable/Apple icons and favicon.
- Full ESLint and npm run typecheck passed, including database-readiness verification (read-only; no protected files changed).
- npm test passed outside sandbox: 68 browser-environment files / 899 tests plus 35 Node-environment files / 681 tests = 1,580 tests. Initial sandbox run could not bind synthetic loopback servers; rerun with required access passed.
- Default npm run build could not complete: first Google Fonts access was blocked, then Turbopack's PostCSS worker port binding was blocked even on rerun. Supported diagnostic npm run build -- --webpack passed, including TypeScript and all static pages. No project build configuration changed; default Turbopack build still needs confirmation in the owner's environment/CI.
- Production served on localhost:3138 with ODDS_DATA_SOURCE=fixture and ODDS_COLLECTION_PROFILE=disabled. Main-page initial-state mobile Lighthouse accessibility: 95, exceeding >=90 target, using Lighthouse 13.5.0 / HeadlessChrome 155, 412x823 viewport. Color-contrast audit still reports failures for muted/error text. [Machine-readable summary](verification/136-lighthouse-main.json).
- Production populated fixture matchup visually verified; [phone](screenshots/136/production-matchup-phone-375.jpg) and [desktop](screenshots/136/production-matchup-desktop-1440.jpg) screenshots captured. Provider credits consumed: zero.
- Authenticated account verification remains removed from #136 acceptance by the owner's scope amendment; isolated account/admin component evidence is labeled as fixtures.
- Chrome installability and installation subsequently verified after owner authorization; see evidence below.
- Owner-run Codex review, fresh push consent, PR screenshot links and owner merge remain pending. No service worker, protected directory or CI changes; no push or PR created.

## Chrome installation verification — 2026-10-18

- Google Chrome 155.0.8059.40 (Official Build, arm64), macOS 14.6.1. Used production fixture server at http://localhost:3138/.
- Application > Manifest displayed EdgeTrace name/short name, standalone display, root start URL and all three icons. No blocking installability errors. Two optional warnings request wide/mobile screenshots for Richer PWA Install UI; these do not prevent the minimal manifest installation.
- Maskable safe-area preview selected. Chrome offered Install EdgeTrace, installation reported Successfully installed, and Open tab in app launched an EdgeTrace application window without browser tabs. The installed target is the local fixture server and requires that server to remain running.
- Evidence: [manifest](screenshots/136/chrome-manifest.jpg), [installation success](screenshots/136/chrome-install-success.jpg), [standalone application](screenshots/136/edgetrace-installed-standalone.jpg).
- No service worker/offline capability added, no provider calls, no app publication or remote deployment performed.

## Selector-caret follow-up

Owner reported the native game selector caret flush against the right edge. Retained the native select, suppressed its platform arrow and added a decorative pointer-transparent chevron with 12 px right inset and 40 px text padding. Verified at 375 and 1440 px; game selection still works and the control remains 44 px tall. All 17 slate-browser tests, TypeScript, changed-file ESLint and whitespace checks passed. [Phone evidence](screenshots/136/selector-caret-phone-375.jpg).

## Idle tracking-status follow-up

Owner approved distinguishing no watched prop from an interrupted connection. Indicator remains visible and selector-based; no primary watch now displays a neutral “Not tracking” dot/label with a short explanatory tooltip. Actual connection states remain intact when a primary watch exists. Browser fixture verification: idle → Watch → Fixture stream → Clear → Not tracking. Tests cover disconnected-with-watch versus idle, plus connection changes while account data is loading/failed. Both follow-ups passed 19 focused tests, TypeScript, changed-file ESLint and whitespace checks. [Phone evidence](screenshots/136/idle-tracking-phone-375.jpg).
