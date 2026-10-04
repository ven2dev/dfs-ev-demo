# Preview environment isolation

Vercel Preview is safe to exercise without reading or mutating Production data
or spending Production Odds API quota. This boundary is enforced in both
deployment configuration and application code; it is not inferred from a
missing key.

## Environment contract

| Environment | Odds source | Neon | Firebase | Collection |
| --- | --- | --- | --- | --- |
| Production | `live` (unset temporarily defaults to live during rollout) | Production-only resource | Production-only project | Production profile and triggers only |
| Vercel Preview | `fixture` only | Preview-only resource | Preview-only project | Hard-refused |
| Local/test | `fixture` by default | Developer-selected | Developer-selected | Disabled unless explicitly configured |

`VERCEL_ENV` defines the deployment class. A non-Vercel or self-hosted
deployment has no Vercel classification and is therefore treated like local
development; it must set `ODDS_DATA_SOURCE` explicitly instead of relying on a
deployment default.

Preview has no `ODDS_API_KEY`. Its deterministic fictional slate supports the
signed-out slate, prop-discovery, watch, and EV-stream journey without calling
The Odds API, weather, roster, or player-stat providers and without writing
provider-shaped observations, telemetry, caches, or crosswalk rows.

The two Neon resources are separate projects connected to mutually exclusive
Vercel environments under the normal unprefixed database variable names. Do
not reconnect either database to both environments. Applying `db/schema.sql`
to Preview is safe and idempotent; Preview starts with empty tables and must
not receive a Production data copy.

Preview uses a separate Firebase web app, Authentication tenant, Firestore
database, and Admin service-account key. Browser Firestore access is denied by
the source-controlled `firestore.rules`; server routes use the Preview Admin
credential. Deploying the same deny-all rules to Production remains a separate
Production change and requires explicit approval.

The source-controlled deny-all rules were deployed to Preview and verified on
2026-10-03. `npm run test:firestore-rules` independently proves that signed-out
and signed-in browser clients can neither read nor write. The Firestore
emulator requires Java 21; CI pins that version and caches the downloaded
emulator binary.

## Access and Google sign-in

Vercel Deployment Protection remains enabled. Team members must authenticate
to Vercel before opening the stable Preview URL:

`https://dfs-ev-demo-preview.vercel.app`

That hostname is the only Vercel Preview hostname authorized in Preview
Firebase. It supports Google sign-in after Vercel access succeeds. Generated
PR deployment hostnames are intentionally not authorized for Google sign-in;
their supported journey is signed-out fixtures. This prevents an unbounded set
of temporary origins from becoming Firebase auth origins.

The Preview `ADMIN_UID` stays unset until the owner signs into the Preview
Firebase project. If admin-tool testing is required, copy that Preview-only UID
into Vercel Preview. Never reuse the Production UID.

Firebase Admin 14 currently reaches `jose` through the CommonJS
`jwks-rsa` package. Vercel's server runtime cannot load `jose` 6 through that
path, so `package.json` narrowly overrides only `jwks-rsa` to `jose` 5.10.0.
The default test command reproduces Vercel's loader mode with
`--no-experimental-require-module`; do not remove or broaden the override until
the upstream Firebase/Auth0 compatibility issue is fixed and the runtime test
passes without it.

Automation must use Vercel's protection bypass rather than disabling
Deployment Protection. Bypass values are credentials: keep them out of source,
logs, URLs committed to issues, and client bundles.

## Isolation verification

Run identity checks from a clean directory, not the repository root. `vercel
env run` otherwise loads `.env.local`, which can make Preview appear to use the
local or Production resource. Verification output must contain only a short
hash of the database host plus database name and the non-secret Firebase
project ID; never print a connection string or service-account JSON.

The bounded verification on 2026-10-03 compared hashed database identities and
a known Production-only marker dataset without publishing either resource
identifier or the Production row count. Preview resolved to a different, empty
database while the marker dataset remained present only in Production. The
stable Preview deployment also returned a fictional current-week slate,
exact-line three-book prop quotes,
and an SSE EV tick through Vercel's authenticated CLI bypass. After the first
Preview Google sign-in, the authenticated
`GET /api/user-data` and `PUT /api/goal` routes completed against the isolated
resources without runtime errors. Production remained HTTP 200 throughout
provisioning and verification.

## Safe credential and resource rotation

### Firebase Admin key

1. Create one user-managed key on the Preview Firebase Admin service account.
2. Validate the decoded credential's `project_id` and `client_email` before use.
3. Replace `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64` in Vercel Preview as a Secret.
4. Deploy and verify a Preview server route that uses Firebase Admin.
5. Delete the previous Preview key from Google IAM and confirm only the intended
   active user-managed key remains.

Stream the base64 value directly to Vercel. Do not store the JSON in the
repository, `.env` files, shell history, logs, or a retained download. If the
Vercel write fails, revoke the newly created key immediately.

Production key rotation is a separate change: replace the Production secret,
redeploy, verify, then revoke the old key. It requires explicit approval.

### Neon

Vercel cannot narrow a legacy multi-environment marketplace connection in
place. Do not use `vercel env rm NAME preview` on a shared legacy record: it can
remove the entire record, including its Production scope. The safe migration is
an explicitly approved disconnect followed immediately by a Production-only
reconnect, verification of every expected alias, and an HTTP health check before
any redeploy. Connect the isolated Preview resource separately as Preview-only.

For an ordinary Preview credential rotation, rotate through Neon/Vercel,
reapply the schema if the database itself changed, verify its tables are empty,
and produce a new non-sensitive fingerprint. Never copy Production rows as a
connectivity test.

### Odds provider

Preview must remain without `ODDS_API_KEY`; fixture mode also refuses live
operation if a key is accidentally introduced. If paid live Preview testing is
ever required, use a different provider key with an explicit cap and treat that
as a separately approved architecture change.

Deleting a deployment removes its immutable environment snapshot but does not
revoke credentials. After isolation is verified, delete obsolete Preview
deployments that captured Production credentials, then rotate Production
credentials separately if required. Both are explicit operational actions, not
automatic consequences of merging this branch.
