# Configuration and credential inventory (#98)

Step 1 records names and handling boundaries at
`e254a9b351bac53ae7589c725058bf78fb78ad7f`. The owner approved the
[selective hybrid on #97](https://github.com/ven2dev/dfs-ev-demo/issues/97#issuecomment-6904517703):
environment-scoped Vercel Secret variables are authoritative for the deployed
app's runtime credentials. GCSM needs a named second-consumer or audit case and
separate approval; none is selected today. The
[delivery design](secrets-delivery-design.md) defines the Step 2 contract and
its implementation boundaries. The comparison remains in the owner roadmap,
outside the repo.

The [catalog](secrets-inventory.json) is the single structured inventory.
It contains no current values, actual provider resource identifiers, private
file contents, or fingerprints derived from credentials. A source-code commit
identifies what was inspected; it does not identify any secret value.
`sourceCommit` retains the initial inspection checkpoint; the offline checks
reevaluate the current tracked source, rather than claiming deployed state at
that checkpoint.

## Design basis

- **Pattern:** a value-free configuration catalog with source references and
  shared handling profiles. A row names its consumers and overrides a profile
  only when its handling differs. This inventories supplied inputs without
  introducing a secret broker. An offline policy validator and bounded syntax
  discovery check it in CI; no source code is imported or executed for discovery.
  #99's future typed server configuration schema
  will own the executable input definition; catalog coverage will be generated
  from or checked against it, rather than maintained as an independent schema.
- **Alternatives:** an unstructured prose-only list makes completeness and
  missing fields difficult to review; separately repeating every policy in
  every row encourages contradictory updates; discovery by exporting deployed
  values exposes material that classification does not require. These are
  rejected for the catalog. The approved delivery direction is linked above;
  Step 1 implements no delivery mechanism.
- **Targets:** cover supplied environment inputs, computed setting names,
  credential aliases, CLI credential/target selectors, runbook and
  platform-injected credentials, and deliberately refused names;
  give each entry all eleven fields below. Retain zero secret values or
  secret-derived fingerprints. This step changes no read/write path and has
  no latency or database benchmark target.
- **Requirement reasons:** keep names separate from values to avoid disclosure;
  distinguish Production, Preview, disposable tests and owner operations to
  prevent accidental privilege transfer; classify aliases and refusal cases
  explicitly to avoid provisioning nonexistent consumers; retain source and
  verification status to avoid presenting a documented setup as a verified
  deployment. Separate owner approval remains necessary for credential
  rotation/deletion because it can interrupt live consumers.
- **Assumptions:** current source is a Next.js app on Vercel, with Firebase,
  Neon, a Hostinger external cron caller, a GitHub operational monitor, and
  owner-run local pipeline tools. Source and public metadata can establish
  names and contracts. Actual deployment settings, IAM, account recovery,
  billing, variable types and copy counts need separate value-free owner
  confirmation; this step does not inspect them.

## Reading the catalog

Each `entries` row contains an exact `name`, a `kind`, a `profile`, source
file paths in `consumers`, and optional `notes`/`overrides`. Resolve a row by
taking its profile, adding its explicit consumers, then applying overrides.
There is no inheritance between profiles. An unresolved field is an error,
not permission to infer access.

| Required field | Meaning |
| --- | --- |
| `classification` | Secret, sensitive identifier, or ordinary configuration |
| `environments` | The separate environments/operations where it belongs |
| `owner` | Accountable role, without account identifiers |
| `consumers` | File paths that use, declare, alias or refuse the name; `kind` distinguishes these cases |
| `currentStorageClass` | Documented storage class and its verification limit |
| `intendedSourceOfTruth` | Approved delivery authority, distinguished from provider issuance/revocation authority |
| `deliveryMethod` | Current contract or explicitly labeled approved design; implementation remains separate |
| `rotationAuthority` | Who can issue/change/revoke it and the separate approval boundary |
| `recoveryDependency` | Account, role, deployment or private recovery prerequisite |
| `ciPermission` | Whether actual, public throwaway or synthetic-only material can reach the named job |
| `agentPermission` | Whether values may enter an agent session; #98 needs only names and synthetic material |

`consumers` are evidence of source behavior, not a live access or IAM audit.
Validation checks that each name appears in every listed file, without pinning
line numbers that unrelated edits can move. For refused prefixes, the trailing
`*` denotes a namespace; validation checks the prefix text. Runbook categories
use actual source phrases (`protection bypass`, `authenticated CLI bypass`,
`provider recovery`, `token`) and notes identify the credential they describe.
The catalog CLI's option names omit the leading `--`; their `kind` identifies
the command. Secret aliases share the underlying credential's rotation
boundary; a prefix does not claim that every possible member exists.

## Scope and discovery

**Inclusion rule:** record supplied configuration inputs: environment variables,
CLI credential/target selectors, runbook credentials, platform-injected
credentials and deliberately refused names. Exclude source-controlled policy
key paths, constants, workflow-internal state and artifact paths unless they
carry or select a credential. A name's appearance in an `env` map does not by
itself make workflow bookkeeping a supplied configuration input.

Discovery reviewed tracked TypeScript/JavaScript accesses and destructuring,
child-process maps, computed collector setting calls, both `.env.example`
templates, workflows, Compose, Turbo and operator runbooks, then applied that
rule. Both literal and computed supplied names are included. In particular,
`integerSetting(name)` in the collector and the R2 helper's explicit `values`
argument are not missed by limiting discovery to `process.env.NAME`.

For example, Dependabot/Compose/Next policy key paths, `APP_RESULT`,
`GITHUB_OUTPUT`, benchmark output paths and source constants are excluded.
The remaining test/runtime flags are externally supplied process controls.
`TEST_DATABASE_TEMPLATE_MANIFEST` remains because it selects the registered
disposable database template, rather than naming an evidence output. API user
sessions are outside the deployment configuration catalog; the creator review
token remains because an owner runbook delivers that local capability.

Documentation mentions such as `DATABASE_NAME` and `HOST_FINGERPRINT` are
placeholders for the catalog CLI's `--expected-database` and
`--expected-host-fingerprint` arguments, not extra environment variables.
`DB_TEST_RUN_ACTIVE`, `ERR_PACKAGE_PATH_NOT_EXPORTED` and `TURBO_SELECTION` are
error/output labels. `NEXT_PUBLIC_` is a framework prefix, not an individual
credential. These are not counted as additional environment inputs.

## Current trust boundaries

| Boundary | Names / credential categories | Current contract and authority |
| --- | --- | --- |
| Application server | `ODDS_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64`, `DATABASE_URL`, `DB_READINESS_SECRET` | Explicit deployment configuration; Firebase Admin and DB modules are `server-only`; provider/role owner controls issuance. Actual values/types/copies were not inspected. |
| External collector caller | `CRON_SECRET` | Hostinger calls the deployed collector; the same bearer also protects player-stat sync. Documented calling copy and server copy rotate together. No database/provider key is needed by Hostinger. |
| Operational monitor | `ODDS_HEALTH_SECRET` → `HEALTH_SECRET`; `ODDS_HEALTH_URL` → `HEALTH_URL` | Repository Actions secrets feed the no-checkout Collector Health job. Only the bearer is a secret by classification; the endpoint remains a resource identifier even though GitHub stores it as a secret. |
| Public browser configuration | Six exact `NEXT_PUBLIC_FIREBASE_*` names in the catalog | Intended to be bundled; authorization depends on Firebase Rules, App Check and API restrictions, not hiding configuration. Firebase Admin key material is separate. |
| Server authorization/configuration | `ADMIN_UID`, `ODDS_FREE_PILOT_EVENT_ID`, collector profiles/tuning | UID and event ID are identifiers; the remaining policy settings are ordinary configuration. Changes can affect authorization, quota or collection scope without being credential rotation. |
| Preview | Separate Firebase Admin/web configuration, Neon target and optional Preview UID | Fixture-only provider behavior. No Production Odds key, Production data copy or fallback to Production credentials. Source contract is recorded in [Preview isolation](preview-environment.md). |
| Disposable test databases | `TEST_DATABASE_URL`, `DB_TEST_*`, container `POSTGRES_DB`/`USER`/`PASSWORD`, `FS244_SOURCE_DATABASE_URL` | Public throwaway fixture credentials and registered loopback lanes. Replay currently requires lane-2 large; its source URL is not a hosted data credential. |
| Owner creator tools | `YOUTUBE_API_KEY`, `CORPUS_DATABASE_URL`, per-run review token | Explicit owner terminal entry; corpus URL is registered loopback/`corpus_importer`. Private creator inputs stay outside agents. The review token is an ephemeral local browser capability. |
| Owner migration/catalog operations | `MIGRATION_DATABASE_URL` and explicit target/evidence CLI options | Direct non-pooled connection, no application URL fallback or dotenv discovery. Remote mutation remains separately blocked under #95; account/PITR recovery remains #86. |
| Owner local integrity operation | `FS170_DATABASE_URL` | Explicit loopback target; the tool checks against an ambient application URL. This is not a qualified hosted scrubber. |
| Synthetic-only R2 proof | `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_LIVE_CONTRACT` | Existing ignored local file and explicit live-test opt-in; the helper restricts the synthetic test bucket. R2 is not the default pipeline store. No file or credential was read by #98. |
| Platform/owner sessions | `github.token`/`GH_TOKEN`, Vercel bypass/session credentials, provider recovery factors | Keep generated job identities, owner administration and application credentials separate. Ordinary CI is not authority to receive Production application secrets. |

Relevant consumers are [Firebase Admin](../apps/web/src/lib/firebaseAdmin.ts),
[Firebase browser config](../apps/web/src/lib/firebaseClient.ts),
[server DB](../apps/web/src/lib/db.ts), [API authorization](../apps/web/src/lib/apiAuth.ts),
[collector route](../apps/web/src/app/api/cron/collect-odds/route.ts),
[Collector Health workflow](../.github/workflows/collector-health.yml),
[R2 test helper](../services/pipeline/tests/support/r2TestConfig.ts),
[local corpus target](../services/pipeline/scripts/creator-corpus/importTarget.ts),
and [DB test target](../packages/db/tooling/tests/target.mts).

The catalog records separate recovery dependencies rather than treating a
provider API key as sufficient for account recovery. Provider administrator
recovery dependencies are fields, not invented environment-variable names.
The runbook's Neon recovery and Vercel bypass/session categories remain even
where no environment variable is committed.

## Verification status and findings

- Repository metadata reports secret scanning and push protection enabled.
  Repository Actions secret names are `ODDS_HEALTH_SECRET` and
  `ODDS_HEALTH_URL`; the GitHub environments named Preview and Production
  returned no environment-secret names during intake. Values were not read.
  This says nothing about Vercel variables, organization-level grants or
  local/private copies. [Security operations](security-operations.md) retains
  #59's existing limits on generic pattern detection and optional validity
  checks.
- `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64` is the actual app credential name.
  The owner-approved #98 addition closes the initial DB guard gap: it now
  refuses that exact name and all cataloged secret shell inputs by presence,
  including blank inputs. The existing `FIREBASE_ADMIN_*`, `POSTGRES_*` and
  `PG*` refusals remain. This prevents owner/CI credentials reaching disposable
  test processes; no real credential was used to verify it.
- The monitor intentionally receives its endpoint bearer while ordinary CI
  remains free of Production application credentials. `github.token` is a
  GitHub-issued job token, not evidence of a permanent owner PAT.
- Hostinger cron and Collector Health currently pass their bearer in an HTTP
  header argument. This records a process/configuration exposure surface;
  Step 1 does not change either caller or its schedule.
- Base64 does not protect Firebase Admin key material. The encoded JSON is
  one provider credential, including its private key and identity metadata;
  that does not justify bundling unrelated credentials into it.
- The actual Vercel plan, Secret/Config types, OIDC setup, GCSM/billing/IAM,
  Bitwarden adoption, account recovery and complete private-copy ledger are
  unverified. An inventory of current storage *classes* is not an attestation
  that a deployed value has the intended scope.

## Step boundary

Step 1's offline check resolves all eleven fields for 87 entries across 14
profiles, checks each name in 252 cited file references, and checks local links. It
rejects removal of the real `ODDS_API_KEY` row, a missing rotation authority,
and a reference to a file that does not contain the name. These are catalog
checks, not new runtime tests or proof of deployed credential access.

The inventory fields are populated through profiles and explicit overrides.
Step 2 adds the [hybrid design](secrets-delivery-design.md) and `copyLedger` for
six independent runtime credentials. It records the GitHub/Hostinger calling
copies, workflow aliases, deployment snapshots and unresolved readiness caller.
The ledger states intended authority and verification limits; it neither
asserts byte equality nor authorizes an unknown private copy. The 87 input
entries, profiles and source references are unchanged in scope.

#99's Google-first premise is superseded by the linked amendment; it owns the
typed server-only validation boundary, fail-closed behavior and Preview
isolation. Its executable names, classification, capability and environment
rules will generate or be checked against the catalog's runtime subset, with
raw accesses checked outside explicitly approved adapters. #100 owns any
justified Bitwarden adoption; none is selected today. #101 owns separately
approved migration/rotation, live-scope verification and retirement of copies.

#99 relocates application input references to its typed server/client readers;
the input names, classifications, delivery authority and copy ledger stay the
same. The client-safe odds contract no longer reads environment inputs, so its
server policy tests are referenced at their new executable owner. #287 replaces
discovery with schema alignment and lint enforcement; discovery remains active
until that companion is reviewed and merged.

#99 uses the existing public Firebase project ID to check service-account
agreement before initialization/reuse, without extra expected-identity inputs.
Agreement does not establish the intended deployed project. Database URL checks
are structural only; #101 verifies deployed host/database/role, targets and
permissions. See the [runtime boundary](typed-configuration-boundary.md) for the
implemented local checks and their synthetic evidence.

No runtime code, workflow, template, deployment, IAM or credential has changed
in Steps 1–2. Step 3 changes template comments and runbook setup references,
and adds the offline checks described below. Synthetic validation can establish field/reference coverage;
it cannot establish real authentication, effective permissions, secret access
auditing, billing state, outage performance or recovery readiness. Those
claims require their separately approved evidence.

## Setup and change checklist

1. Find the exact input in the catalog, resolve its profile/overrides, and use
   the delivery design's environment, authority and copy rules. Missing
   ownership or an unknown caller is a review item, not permission to create
   a new copy. This prevents untracked consumers from retaining access.
2. Start local/test work from the blank credential names and fixture defaults
   in [the web template](../apps/web/.env.example), or the explicit synthetic
   R2 contract's [pipeline template](../services/pipeline/.env.example).
   These are not instructions to retrieve deployed credentials. Owner-only
   operations keep their existing explicit input/target checks; Production
   values stay outside ordinary CI, Preview and agent sessions.
3. For deployed setup, the owner confirms Secret type, exact environment scope,
   provider identity and permissions without exporting values. Provider-managed
   Neon integration changes, actual delivery/rotation, caller coordination and
   old deployment retirement require the separately approved #101 operation,
   because a setting change alone does not update a running deployment.
4. Update input rows, policy and intentional-copy metadata when configuration
   changes. Keep source paths and name occurrences current. Reasons in
   `discoveryExclusions` document out-of-scope artifact/workflow/generated
   state; editing an exclusion is a scope decision and deserves review.
5. Run `npm run test:ci-gate` on Node 24. For the focused offline check, use
   `node --test tests/secrets-inventory.check.mjs`. Full #98 verification also
   runs typecheck, lint, the normal test suite and a production build with
   synthetic/empty inputs; no provider authentication is needed. The checker
   is included in CI's unconditional App gate verification step so affected
   task selection cannot bypass it.

Relevant runbooks: [Preview](preview-environment.md),
[collector/Hostinger](odds-collector-operations.md),
[security operations](security-operations.md),
[owner creator operations](creator-corpus-operations.md) and
[migration/recovery boundary](database-migrations.md). #100 and #101 own any
new local store or actual credential migration. Neither merging #98 nor
running its checks provisions a store, grants permissions or rotates a value.

## Offline check scope and test evidence

[The checker](../scripts/security/secrets-inventory.mjs) validates the format,
the eleven required fields, profile resolution, classifications, unique names,
source paths/name occurrences and the runtime copy ledger. It reads tracked
source files only, excludes private `.env*` files and evidence/fixture trees,
and refuses source symlinks before reading to prevent traversal into private
material. It does not inspect process environment values or contact providers.
New source files enter discovery when tracked; a pre-staging run cannot claim
coverage for arbitrary untracked files.

Discovery covers literal dot/bracket environment access, destructuring, known
environment adapters (`env`, `environment`, `values`, `runtimeEnv`,
`runtimeEnvironment`), collector `integerSetting` calls, template assignments
and workflow `secrets`/`vars` references and secret aliases. It ignores source
comments and string examples. It is not whole-program data flow: new adapter
forms, dynamic name construction, runbook-only/CLI names, effective grants and
copy completeness still need review. #99's typed module will replace the
runtime discovery contract with schema alignment; no separate handwritten
executable runtime schema is introduced here.

The eight Node tests use the real repository/checker plus synthetic mutations:

| Check | Failure it exposes |
| --- | --- |
| Repository catalog and blank secret template slots | Missing policy/source/ledger coverage or a filled credential example |
| Remove actual `ODDS_API_KEY` and its ledger row | Source discovery finds a missing real consumer even when both catalog records are deleted |
| Remove policy, shrink required fields, duplicate input, unknown format | Incomplete/ambiguous policy cannot pass by weakening the catalog's own field list |
| Move lines, rename input, wrong/unsafe reference | Line movement stays valid; a stale name, line-pinned or private/outside path fails |
| Add supported source/template/workflow input | An uncataloged input fails discovery; comments/string examples do not create fake inputs |
| Duplicate authority, wrong/missing alias, reclassify credential/public input | Copy drift and secret/public classification errors fail against actual source aliases |
| New excluded-looking name or malformed exclusion | New names need an entry or a reason; an exclusion cannot hide an already cataloged credential |
| Tracked synthetic private env file and source symlink | Source reading omits private files and refuses a symlink instead of following it |

These prove catalog handling and detection of the named regressions. They do
not prove deployment isolation, key validity, redaction throughout application
routes, effective IAM or runtime secret-use auditing. Existing server-only
guards and synthetic app tests remain separate; #99 implements and tests the
missing unified runtime validation contract.

## Disposable DB credential refusal

[The guard](../packages/db/tooling/tests/target.mts) rejects the catalog's
secret shell inputs independently of this JSON, so editing catalog policy
does not silently alter executable access rules. Its
[coverage test](../packages/db/tooling/tests/target.check.mjs) resolves profiles
and overrides for every secret row and exercises each exact input or a
synthetic member of a refused prefix. Nonempty, empty and undefined entries
all refuse by presence. The error text is fixed and contains no supplied value.

`dbTestGuardException.reason` records the five non-shell cases: the
`github.token` context (its `GH_TOKEN` shell alias is refused), the generated
creator `token`, and the three owner-session/bypass/recovery runbook categories.
These are not permission to pass credentials to DB tests. A future named shell
input needs its own row and guard coverage. Any intentional exception or
classification change needs review because it can weaken this boundary.

Two additional guard tests check real catalog coverage and demonstrate that
new/reclassified secrets and missing/blank exception reasons fail. They use
only synthetic values; they neither read credentials nor open a database lane.
The catalog still has 87 entries and 14 profiles; it now cites 265 source
references, including guard refusals. `consumers` can name a refusing source,
as distinguished in each row's notes, rather than an authorized consumer.
