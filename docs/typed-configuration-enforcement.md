# Configuration ownership enforcement (#287)

## Design basis

- **Pattern:** static ownership enforced with existing core ESLint rules, plus
  two-way alignment between executable input definitions and catalog policy.
  The [approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/287#issuecomment-6955456041)
  follows [#99's runtime boundary](typed-configuration-boundary.md), merged in
  [PR #293](https://github.com/ven2dev/dfs-ev-demo/pull/293).
- **Alternatives:** generic executable AST discovery duplicates runtime
  knowledge without preventing bypasses; manual catalog review alone cannot
  enforce ownership; a custom lint plugin adds maintenance when core selectors
  can express the named forms. Duplicating capabilities and parsing contexts in
  catalog JSON was rejected: those would be a second hand-maintained runtime
  specification, and drift would report a forgotten copy update rather than a
  policy problem. Delivery scope and parsing context mean different things.
  Disabling all inline configuration was rejected because the existing justified
  React dependency-rule disable remains valid.
- **Targets:** zero unapproved raw environment access in production
  `apps/web/src`; exact two-way alignment by input name, server/client reader
  and resolved classification; zero input reads, parser calls, private-dotenv
  reads or SDK/SQL/network work while inspecting definitions; all non-discovery
  inventory safeguards retained. No application runtime work is added.
- **Requirement reasons:** the raw-access restriction prevents consumers
  bypassing validation; explicit reader policy prevents moving an input into
  the browser unnoticed; exact classification prevents silent reclassification;
  two-way names catch missing and unread app rows. Capabilities and parsing
  contexts stay code-owned to prevent competing runtime specifications. Narrow
  exceptions preserve synthetic tests and the compiler guard without exempting
  new runtime helpers. Targeted directive checking prevents named rule disables
  from hiding bypasses while preserving unrelated legitimate disables. Value-free
  imports keep inventory tooling from retrieving credentials. Discovery is
  retired only after replacement checks pass to avoid a coverage gap.
- **Assumptions:** Node 24, ESLint 9, Next 16.4.6 and the current TS-aware test
  loader; trusted reviewed configuration definitions and deployment operators.
  Non-app tools remain explicitly cataloged and reviewed. Static checks cover
  the named syntax forms, not arbitrary JavaScript data flow or live deployment
  permissions. #101 retains intended-resource and permission verification.

## Checkpoint 1: enforcement and feasibility

`eslint.environment.mjs` supplies core `no-restricted-syntax` and
`no-restricted-imports` options. `eslint.boundaries.mjs` composes them with the
existing web import restrictions; flat-config rule arrays replace rather than
append, so the existing selectors are retained explicitly.

Only `config.server.ts` and `config.client.ts` own application input reads.
Colocated `*.test.*` and `*.spec.*` files retain synthetic environment injection.
Owner/build scripts outside app source retain their separate review/catalog
obligations. Production imports of exempt test/script code are rejected for
static imports, dynamic imports and require calls; a new runtime helper gets
no reader exemption.

The checks reject direct, bracket, computed, optional, destructured and aliased
process/environment access, process imports and named global-process forms.
Acquiring `process` or `globalThis`/`global` handles is restricted to prevent
the tested alias bypasses. Local slate variables named `window`, object
properties and `typeof window` remain valid. This is a bounded syntax contract;
it does not claim scope-aware arbitrary alias/data-flow analysis.

The instrumentation exception permits only the literal
`process.env.NEXT_RUNTIME === "nodejs"` in the exported `register()` body in
`apps/web/src/instrumentation.ts`. It preserves Next's documented compiler
substitution. Other reads, optional/bracket variants, a moved guard or different
comparison are rejected. The application/compiler guard itself is unchanged.
The final integration checkpoint separately verifies executable Edge output.

`scripts/security/config-enforcement.mjs` uses the actual ESLint parser to
inspect comments. It rejects named disables or inline `off` configuration for
the two environment-access rule IDs in guarded production sources. It does not
set `noInlineConfig`. The legitimate `react-hooks/exhaustive-deps` disable in
the creator-submissions page is tested through the real ESLint configuration.
Strings or discussion text resembling directives do not count as disables.

`test:ci-gate` runs enforcement and import probes unconditionally, so affected
app selection cannot skip them. The definition probe uses the existing
TS-aware loader and `react-server` resolution in a separate invocation with
`envDir: false`, a synthetic-only environment and a temporary dotenv canary.
It imports the real modules, inspects definitions and constructs lazy config
instances under traps without calling capabilities.

The corrected feasibility run passes all eight enforcement groups. The import
receipt reports 20 server and seven client definitions with zero input reads,
parser calls, SDK calls, SQL calls, network calls and private-dotenv reads.
An initial parser-invocation bug and an overly broad `window` selector were
stopped and corrected with owner approval before any commit; their local
receipts remain history. Positive cases cover those regressions directly.

## Checkpoint 2: catalog alignment and discovery retirement

The catalog has app `reader` fields and alignment compares only exact names in
both directions, reader and classification resolved from existing profiles or
overrides. Existing `secret`, `sensitive identifier` and `ordinary configuration`
literals remain unchanged; public Firebase settings currently classify as
ordinary configuration with a client reader. The catalog keeps authority,
delivery scope and its copy ledger. Capabilities and parsing contexts remain
solely in executable definitions. The pure `checkConfigurationAlignment`
function inspects the actual definition maps through the value-free import
probe. No second schema, configuration reader or parser is executed. The
unconditional CI gate runs both policy checks and actual-definition alignment.

The focused replacement checks pass with all 20 server and seven client
definitions aligned, and zero input, parser, SDK, SQL, network or private-dotenv
activity. Mutation tests refuse missing/renamed rows, removed reader bindings,
unread app rows, switched/unknown readers, duplicate owners and classification
changes. Profile overrides resolve before comparison; code-owned capabilities
and contexts are not inspected.

Generic executable-code AST discovery is retired. Template/workflow extraction,
source/reference safety, policy fields, ledger/alias coverage, blank secret
templates and DB credential refusals remain. The approved exclusion list still
records scope decisions for template/workflow names; it cannot hide runtime
definition drift or lint bypasses. Non-app scripts/tools keep their explicit
catalog/review obligations, with no claim of automatic code completeness.
The catalog remains 88 rows/14 profiles with 27 reader bindings. Missing reader
source references for `ADMIN_UID` and `VERCEL` now point to `config.server.ts`.
No runtime source, classification, delivery policy, copy ledger, dependency or
work budget changes.

## Remaining checkpoint and limits

Checkpoint 3 rediscovers all open feature branches and owner-local work. Ask the
owner whether the two local #220 harness branches (`planetscale-harness` and
`hosted-harness`) are still active before including or excluding them, and record
the answer. Merge main in disposable checkouts without rebasing or pushing;
conflicts/unavailable sources are blockers. Record source/merge/checker SHAs,
violations and concrete owner fixes. Repeat affected checks if source changes.
The final handoff records replacement coverage, retained non-app limits and the
production/Edge build proof. Its PR closes both #287 and #99.

The approved estimate is 3.1–4.2 hours of active work, excluding review/CI waits
and unrelated branch-conflict repair. Exceeding five hours requires a measured
re-estimate and split proposal. Every checkpoint stops for commit approval;
every push needs fresh consent. After each merge from main, rerun the CI gate
and full suite before pushing because pre-merge results cannot qualify a new
integration tree. No database lane or live provider operation is needed.
