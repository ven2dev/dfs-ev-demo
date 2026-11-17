# Selective hybrid credential delivery (#98)

This is the delivery design approved in the
[#97 owner amendment](https://github.com/ven2dev/dfs-ev-demo/issues/97#issuecomment-6904517703).
It supersedes the Google-first premise in the original #97–#99 issue bodies.
Vercel Secret variables, scoped per environment, are the delivery authority for
the deployed app's runtime credentials. Google Cloud Secret Manager (GCSM) is
reserved for an individually approved second-consumer or retrieval-audit need;
none is selected today. Provider issuance and revocation remain with the provider.

The [catalog](secrets-inventory.json) records names and handling policy; its
`copyLedger` records intended authority and known delivery copies. Source
inspection is pinned in `sourceCommit`. A documented copy is not an attestation
of its current value, type, scope or complete private-copy count. This step
implements no delivery, IAM, rotation or application change.

## Design basis

- **Pattern:** platform-native secret injection, separate environment identities,
  one declared authority per credential and an explicit copy ledger. #99 adds
  one typed server configuration boundary. This follows the existing app's
  deployment model without introducing a remote secret lookup dependency.
- **Alternatives:** GCSM for every runtime credential would add billing,
  federation, cold-start retrieval and outage handling without a current
  consumer that needs them. Independently authoritative copies in multiple
  stores would make rotation and recovery ambiguous. A custom secret-returning
  API would add an unnecessary privilege boundary. None is selected. Keeping
  every credential in Vercel forever is also rejected: a future consumer or
  audit requirement can justify Google through the approval path below.
- **Targets:** retain all 87 catalog entries and their eleven resolved fields;
  name the delivery and permission boundary of each credential; retain zero
  values, actual resource identities or secret-derived fingerprints. The
  selected design adds zero remote secret-manager calls per request or cold
  start, zero Google active versions and zero Google access operations.
  There is no new read/write path in #98, so no speed claim or database spike
  is made. Any future remote delivery path needs its own measured latency,
  availability and quota targets before activation.
- **Requirement reasons:** one authority prevents conflicting rotations; an
  explicit copy ledger prevents forgotten callers and snapshots; environment
  identity validation prevents a correctly formatted credential reaching the
  wrong resource; validation before side effects prevents partial privileged
  work; sanitized failures prevent credential disclosure; separate rollout
  approval prevents an inventory change interrupting live consumers.
- **Assumptions:** the app remains on Vercel with deployment-injected variables;
  Hostinger is an external HTTPS caller and GitHub runs an operational monitor.
  Trusted server/build code can read injected credentials. The design does not
  isolate secrets from compromised trusted code or grant agents Production
  access. Current provider permissions, Vercel types/plan and private copies
  remain unverified until owner-controlled rollout evidence exists.

## Delivery and environment boundaries

Use Vercel's **Secret** type for server credentials. Unlike Config, Secret is
unreadable to members after saving but available to deployments. Encryption at
rest alone does not establish this property. Scope Production, Preview and
Development independently; check the actual type and scope by value-free
metadata during #101. The available Separate Production Secret Values policy
can reinforce separation, but its current setting is unverified.
[Vercel variable types](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types).

| Environment / consumer | Delivery and permission boundary |
| --- | --- |
| Production app | Its Production Secret variables only. Trusted deployment code receives them; Vercel does not provide a separate per-route secret identity here. Human writers use owner-approved project access and MFA. |
| Preview app | Separate Firebase Admin identity, Firebase public configuration and Neon resource; fixture-only odds. No Production Odds key, data credential or Production data copy, to preserve #58. Branch-scoped overrides follow the same boundary. |
| Local developer / ordinary CI | Synthetic stand-ins, fixture odds and public disposable database credentials. An owner-approved local live operation is separate from routine development and agent access. No automatic Production environment pull. |
| GitHub Collector Health | Only its endpoint and narrow health bearer, plus the generated job token described below. It receives no database, provider or Firebase Admin credential. |
| Hostinger cron | Only the collector endpoint bearer. It has no app runtime, database or provider credential. |
| Owner tools | Explicit owner input to the named operation, not app deployment injection. Tool-specific target/refusal checks remain in force. |

The six `NEXT_PUBLIC_FIREBASE_*` inputs remain public project configuration,
statically referenced for browser bundling. Rules, App Check and API
restrictions provide the authorization boundary. `ADMIN_UID` is an authorization
identifier; event IDs, endpoint URLs and tuning values are configuration, not
bearers. Their environment-specific values still matter for isolation.

Vercel settings changes apply to new deployments; an existing deployment keeps
its prior values. There is no runtime manager fetch, cache refresh timer or
secret-fetch retry policy in this design. #99 validates once before the first
use of each required capability and caches validated configuration/clients per
instance. Deployment/replacement renews them. A Vercel settings outage can block
deployment or rotation; it does not add a secret-fetch failure to an existing
instance. Provider/network/authentication outages remain ordinary dependency
failures. [Deployment semantics](https://vercel.com/docs/environment-variables).

For provider-managed Neon delivery, retain the provider integration's issuance
and rotation ownership with exclusive environment scope. Confirm it supports
the intended Secret handling before rollout; any incompatibility returns to
the owner rather than silently adding a competing manual copy or disabling
provider rotation. Vercel documents that integration variables cannot be
converted from the variable list: its procedure involves disconnecting,
rotating and reconnecting with Sensitive enabled, excluding Development.
That is a separately approved #101 operation, not a metadata-only change.
[Integration handling](https://vercel.com/docs/environment-variables/sensitive-environment-variables).
Firebase's encoded service-account JSON is one atomic
credential; base64 is not encryption. Unrelated values stay separate to preserve
independent access and rotation.

## Identity, authority and intentional copies

The catalog ledger covers these six independent runtime credentials; the
`HEALTH_SECRET` alias is part of `ODDS_HEALTH_SECRET`, not a seventh credential.
Every Vercel item has distinct environment instances where applicable.

| Credential | Proposed consumer identity and required authority | Intentional copies and verification limit |
| --- | --- | --- |
| `ODDS_API_KEY` | Production app server's provider key for existing odds requests within the approved collection/quota policy; no account administration. | Production Vercel authority and its deployment snapshots. Preview gets none. Any owner-local live use needs a separately recorded copy. Actual provider key restrictions unverified. |
| `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64` | Separate app service account per environment. Required operations are token verification/revocation lookup, account deletion and user-document read/write/delete, as used by `apiAuth` and the account/user routes. | Environment-specific Vercel authority and snapshots. No browser, monitor or ordinary CI copy. Effective IAM grants are unverified; SDK capability is not proof of least privilege. |
| `DATABASE_URL` | Environment-specific application database role for the existing serving, collector and player-stat operations; no migration, role administration or cross-environment authority. | Environment-scoped provider-managed Vercel authority and snapshots. Provider role grants need owner verification; a connection string is not proof of narrow grants. |
| `CRON_SECRET` | Hostinger collector caller and Vercel player-stat scheduler authenticate to their existing cron routes. Possession permits those triggers, not direct database/provider access. | Vercel authority, deployment snapshots and documented Hostinger calling copy. Current bearer permits both routes; no per-caller cryptographic identity is claimed. |
| `ODDS_HEALTH_SECRET` | Collector Health job: read-only collector health endpoint. | Vercel authority/snapshots; repository Actions secret mapped to `HEALTH_SECRET`. GitHub secret name verified, value/type/copy equality unverified. |
| `DB_READINESS_SECRET` | An owner-approved readiness caller: read-only database readiness endpoint. | Vercel authority/snapshots. External caller and copies are unresolved; #101 needs a named caller/owner before adding or rotating a copy. |

Exact deployed Firebase IAM and database grants are evidence still needed, not
permissions inferred from these descriptions. #101 maps the listed operations
to the provider's exact grants and verifies them in an isolated environment
before rollout. #99 performs local configuration checks only. Any required
wider grant is an owner decision.
The proposed runtime has no Google secret-access role and no static Google
bootstrap key. This separates the required permission contract from an
unperformed live access audit.

Source anchors: [Admin initialization](../apps/web/src/lib/firebaseAdmin.ts),
[token checks](../apps/web/src/lib/apiAuth.ts),
[account deletion](../apps/web/src/app/api/account/route.ts),
[database initialization](../apps/web/src/lib/db.ts),
[Preview isolation](preview-environment.md),
[collector operations](odds-collector-operations.md) and
[Collector Health workflow](../.github/workflows/collector-health.yml).

GitHub's `github.token` is generated per job and exposed as `GH_TOKEN`; it is
not another copy of a persistent owner token. The monitor has empty workflow
permissions and job-level `issues: write` for incident reconciliation, with no
checkout/install or arbitrary PR execution. Its endpoint alias `HEALTH_URL`
comes from `ODDS_HEALTH_URL`, an identifier stored as an Actions secret today.
That storage choice does not make it an authentication credential.

For each copy, #101 records platform, environment, authorized consumer, owner,
delivery/replacement method and verification status without values. A new
caller, environment or retained owner-local copy needs owner review so the
ledger cannot silently become an authorization grant. Old deployment snapshots
are retained copies until retired; one ledger category does not count or verify
every live deployment. Avoid shell history, command arguments and logs when
delivering bearers. Existing Hostinger/monitor header-argument exposure is a
finding; changing those callers is not part of this documentation step.

## Owner workflows and recovery

| Workflow | Selected disposition and permission boundary |
| --- | --- |
| Creator `YOUTUBE_API_KEY` | Retain owner hidden-terminal input to the creator CLI and its provider-header path. No app/agent/ordinary CI copy. Provider key restrictions remain an owner verification item. |
| `CORPUS_DATABASE_URL` / `FS170_DATABASE_URL` | Explicit owner-local registered loopback roles/targets; no app URL fallback. Hosted integrity qualification is separate. |
| `MIGRATION_DATABASE_URL` | Explicit direct non-pooled owner connection; no ambient dotenv/application fallback. Remote mutation remains blocked by #95 and recovery by #86. This design grants no new hosted operation. |
| R2 inputs | Retain existing ignored owner setup for the explicit synthetic-only contract. No Production/public-data authority or general pipeline adoption follows. |
| Vercel bypass/session and provider recovery | Owner-only protected session/recovery workflow with MFA and private recovery material; no bootstrap credentials committed or handed to agents. |
| Creator review token | Per-run local capability; stop/restart invalidates it. No persistent vault copy. |

None currently justifies Bitwarden adoption. #100 can retain secure interactive
entry; it can approve Bitwarden only for a named repeatable workflow where it
reduces plaintext handling and defines exact read-only machine scope, storage,
expiry/rotation, revocation and recovery. It does not imply agent access.
Private-file contents, private account identifiers and recovery factors remain
outside #98. Provider recovery, Vercel access and caller-account recovery are
separate dependencies; possession of an API credential does not prove any of
them. #101 records owner confirmation and a private recovery procedure rather
than placing recovery material in the catalog. An unreadable Vercel Secret is
not a recovery copy: if its value is lost, use the provider's replacement path
or generate a new bearer and coordinate its callers. Do not solve recovery by
silently introducing an unrecorded readable copy.

## Fail-closed contract for #99

#99 implements one `server-only` typed configuration boundary, consumed before
Firebase Admin, database clients, live provider calls or protected operational
capabilities initialize. Validation is capability-scoped: fixture/public routes
and builds do not require unused live credentials. The owner's lighter identity
decision compares the Firebase service account's `project_id` with the existing
`NEXT_PUBLIC_FIREBASE_PROJECT_ID` before initialization and reuse. Database URL
validation is structural only; #101 verifies the intended deployed host,
database, role and permissions. No fallback to another store, environment,
ambient credential or fixture data in Production is allowed, to prevent a failed
configuration from selecting an unintended authority or data source.

| Condition | Required behavior and reason |
| --- | --- |
| Missing/blank/malformed required value | Capability unavailable with a stable sanitized configuration error; no client initialization or protected work. Do not emit input, decoded JSON, connection strings or raw SDK errors. |
| Invalid deployment class, Firebase project disagreement or malformed database URL | Reject locally before protected work. Firebase agreement is checked before initialization/reuse; database host/name/role verification remains #101's deployed check. `VERCEL_ENV` alone cannot prove isolation. |
| Missing/invalid caller bearer | With a configured receiver, reject with the existing 401/403 without protected work. Missing receiver `CRON_SECRET` returns sanitized 500; missing `ODDS_HEALTH_SECRET` returns 503; database readiness retains 503. This distinguishes deployment failures from bad caller credentials. |
| Provider denial, revocation or outage | Return the route's sanitized dependency failure; no alternate credential, environment, fixture substitution or secret-fetch retry storm. |
| Prior cached or already-initialized SDK app | Verify the configured account/project before reuse. Firebase Admin's named `dfs-ev-server` app records its project explicitly and survives reload only when it matches; a default app is never selected. This prevents SDK state bypassing validation. |
| Preview live odds request | Refuse live access and collection; fixture use does not read or require a Production key. |

Separate `EXPECTED_*` identity settings were rejected: they would live beside
the credentials in the same Vercel environment, could be pasted wrong together,
add five settings per environment and duplicate #101's deployed checks. The two
Firebase values agreeing does not prove that they identify the intended project.
Deployment access remains trusted. #101 verifies deployed Firebase/database
targets, effective IAM and opaque provider/bearer provenance; these are the
approved limits of #99, not claims established by its local parsing.

The [#99 runtime boundary](typed-configuration-boundary.md) implements the local
checks and cached-client verification with synthetic evidence. Dependency
logging keeps only safe diagnostic fields and app-source stack locations,
omitting incoming messages, causes and configuration values. Unknown compiled
origins omit stacks. #98's catalog-backed DB test guard remains separate: it
refuses secret shell inputs, with synthetic coverage and explicit non-shell
exceptions. #287 owns lint enforcement and catalog/schema alignment.

## Catalog and #99's typed configuration module

The typed module owns executable names, parsing, capability requirements and
environment rules. Export a value-free definition for checks or generate the
runtime subset of the catalog from that definition; do not maintain a second
handwritten runtime schema. Keep ownership, recovery and copy policy in the
catalog, and join by exact input name.

The future check compares runtime names, public/server classification,
capability consumers and environment requirements in both directions. It also
finds raw environment accesses outside the approved boundary and explicit
public/platform adapters, including computed names. Public Firebase inputs
retain static browser references; owner tools, refused prefixes, disposable
test inputs and generated platform credentials are separately scoped, not
forced into the app server schema. Catalog source checks use paths plus name
occurrence, not line numbers.

Meaningful #99 tests exercise missing/malformed values, environment mismatch,
cached-client reuse, fixture independence and redaction with synthetic markers
and fake clients. They assert zero protected calls on refusal and inspect
client/static build output for synthetic server markers. Coverage checks fail
for an added uncataloged input, a server input classified as public, an
unreviewed direct access or a mismatched environment requirement. No test
contacts a live secret manager or paid provider. #98 Step 3 owns catalog checks
and setup references, not implementation of this runtime boundary.

## When Google becomes justified

A second copy alone is insufficient. The owner approves a named proposal on
the governing issue before provisioning or changing authority. It records:

1. The credential, environment, second consumer or required identity/version
   retrieval evidence, and why native injection plus the copy ledger is
   insufficient. Identify the single new authority and every delivery copy;
   there is no runtime fallback to Vercel if Google is selected.
2. A billed project, billing/recovery owner and accepted spend plan. GCSM needs
   Cloud Billing. Billing on the Firebase project upgrades it to Blaze; a
   separate billed project avoids that upgrade but adds operational ownership.
   This revisits the owner's 2026-10-31 R2 decision partly made to avoid Blaze.
   [Cloud Billing prerequisite](https://docs.cloud.google.com/billing/docs/how-to/modify-project),
   [Firebase billing linkage](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans).
3. One resource per independently authorized/rotated credential and immutable
   release version selection; automatic replication unless a requirement
   warrants otherwise. Separate environment workload identities receive
   `roles/secretmanager.secretAccessor` on exact resources, not project-wide
   roles or mutation permission, to contain compromise.
   [Secret access control](https://docs.cloud.google.com/secret-manager/docs/access-control).
4. A supported keyless identity path, preferably OIDC federation tied to the
   project/environment. Vercel and GitHub need their own narrowed trust/grants;
   Hostinger has no verified federation path. Do not introduce a broad static
   Google key to retrieve narrower secrets. An unavoidable bootstrap requires a
   separate exact scope, storage, lifetime, rotation/revocation and owner
   approval. Vercel deployment identity is not per-route isolation.
   [Vercel federation](https://vercel.com/docs/oidc/gcp).
5. Enabled Data Access logging, retention, access controls and a sanitized
   retrieval-event proof. `AccessSecretVersion` is a DATA_READ operation;
   retrieval logging does not prove every later cached use. These logs are
   disabled by default and can add logging cost.
   [GCSM events](https://docs.cloud.google.com/secret-manager/docs/audit-logging),
   [logging defaults](https://docs.cloud.google.com/logging/docs/audit).
6. Non-Production identity/denial/isolation proof and measured startup,
   timeout, retry, quota, cache lifetime, rotation and outage behavior before
   activation. Fetch at deployment/startup with coalesced bounded reads where
   appropriate; no unreviewed per-request vault dependency. Cached versions
   and old deployments need an explicit retirement policy.

Today this list selects **zero Google secrets**, no Google identities and no
new bootstrap credential. It is an approval contract, not an unused vault
framework to implement or test in #99.

## Rotation, evidence and cost

#101 requires separate owner approval for actual replacement/revocation because
it can interrupt live consumers. The sequence is: establish a replacement;
deliver it to the authoritative environment and approved caller copies; deploy;
verify the active receivers/callers; retire old snapshots/copies and revoke the
previous provider credential. Keep a private copy ledger and public value-free
completion evidence. No old value is republished for rollback after revocation.

External bearers currently have single-value receivers. Updating Hostinger or
GitHub first, or deploying the receiver first, can briefly reject the other
side. #101 plans a coordinated pause/drain and verification window; this design
does not claim atomic rollover or introduce dual-bearer acceptance. Vercel cron
uses its Production deployment's captured `CRON_SECRET`, so deployment/rollback
selection matters too.
[Vercel cron credential lifecycle](https://vercel.com/docs/schedules/cron-jobs/manage-cron-jobs).

| Evidence | What it establishes / limit |
| --- | --- |
| Vercel Activity Log | Administrative env changes and control-plane reads where supported, not every runtime read. Enterprise Audit Logs add export/history capabilities; current plan/retention unverified. |
| GitHub/Hostinger copy metadata | Named authorized delivery location and owner confirmation, not byte equality or proof of every use. No readback of values is needed for this design. |
| Synthetic checks and sanitized rollout result | Refusal/coverage or successful named operation, not full IAM/recovery proof or private-copy completeness. |
| Future GCSM Data Access logs | Retrieval by identity/version only after enablement/retention proof, not subsequent in-memory use or provider actions. |

The accepted Vercel audit limit is explicit; #98 claims no per-secret runtime
access audit. [Activity Log](https://vercel.com/docs/activity-log),
[Enterprise Audit Logs](https://vercel.com/docs/audit-log).

Incremental steady-state secret-management cost for the selected design is
estimated at **$0/month**: no new store, plan upgrade, active Google version or
Google access operation. Existing hosting, provider usage and operational
monitoring are unchanged and not a zero-cost claim. No billing state was read.
Review before the first Google version/access operation, any paid plan/logging
change, or any added copy/consumer. Current baseline includes the documented
Hostinger and GitHub bearer copies and an unresolved readiness caller; unknown
copies need investigation, not a fabricated numeric total. #101 reviews
retained deployment copies during rotation.

If Google is approved later, estimate active-version/replica charges, access
operations, log retention and auth overhead at the then-current
[GCSM prices](https://cloud.google.com/secret-manager/pricing), with numeric
limits approved for that consumer. No free-tier assumption substitutes for
billing approval, and budget alerts do not cap charges.

## Step boundary and remaining evidence

Step 2 changes the design and catalog policy only. Step 3 adds/reviews setup
references and synthetic catalog checks, then runs #98's full verification.
#99 implements the typed boundary; #100 decides any local-store adoption;
#101 performs separately approved delivery/rotation and confirms actual
scopes, grants, caller copies, recovery and logging. This design authorizes
none of those operations. No values, private credential files, hosted secret
responses or Production commands were used to write it.
