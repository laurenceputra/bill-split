# BillSplit

A small, private BillSplit PWA built for Cloudflare Workers. It uses React/Vite for the mobile-first client, Hono for the API, D1 for relational data, and optional R2 attachment metadata. Financial values are integer minor units (for example, `1234` is USD 12.34) and currencies are kept separate.

## Development

Requirements: Node 18+ and npm. The intended package manager is npm (the lockfile is checked in).

```sh
npm install
npm run dev                 # Vite UI only
npm run typecheck
npm test
npm run build
```

For an end-to-end Worker with local D1 and static assets:

```sh
npm run db:migrate:local
npm run db:seed
npx wrangler dev
```

Production defaults to `ENVIRONMENT=production` and has no development bypass. For local Worker development use the named Wrangler environment (`npx wrangler dev --env dev`) or explicitly provide `ENVIRONMENT=development`; only that exact value enables the local `X-Dev-Email` helper. The browser adds this helper only in a Vite development build. Production uses same-origin requests and naturally relies on the Cloudflare Access session; it does not manually provide a bearer token. The Worker verifies `Cf-Access-Jwt-Assertion` (case-insensitive through the Headers API), with an `Authorization: Bearer` token accepted as a compatibility fallback.

## Cloudflare setup and deployment

1. Use the provisioned D1 database configured in `wrangler.toml` and apply its migrations:

   ```sh
   npx wrangler d1 create bill-split
   # copy its database_id into wrangler.toml
   npm run db:migrate:remote
   ```

2. Configure Cloudflare Access for the Worker hostname. Set `ACCESS_TEAM_DOMAIN` (for example `team.cloudflareaccess.com`) and `ACCESS_AUD` as Worker variables/secrets; these values are intentionally not included here. For example, an operator may use `npx wrangler secret put ACCESS_TEAM_DOMAIN` and `npx wrangler secret put ACCESS_AUD`, or configure them in the dashboard. `src/worker/index.ts` obtains the Access JWKS from `/cdn-cgi/access/certs` and verifies the JWT signature, issuer, and audience before using its email claim. A raw email header is not trusted in production. Use `npx wrangler types` when binding or variable changes need regenerated Worker types.

   Recommended session settings are a shorter application/policy session (24 hours or 7 days) and a one-month global session. Access sessions are not sliding, and BillSplit stores no application refresh token. Managed OAuth may make monthly reauthentication silent, but users can still see the reconnect banner when the Access session expires. Never place real domains, audiences, credentials, or tokens in this repository.

3. Deploy:

   ```sh
    npm run deploy
    # equivalent explicit production/default environment:
    npx wrangler deploy --env=""
    # inspect the bundle and bindings without uploading:
    npm run deploy:dry-run
   ```

Wrangler serves `dist` through the Workers Static Assets binding and routes `/api/*` to Hono. API errors are returned by Hono and are not hidden by SPA fallback. Do not put secrets in `wrangler.toml`; use `wrangler secret put` or the dashboard. Add this optional binding when receipts are enabled:

```toml
[[r2_buckets]]
```

The schema already includes attachment metadata. Receipt upload/download is deliberately not part of the core UI; an implementation should generate short-lived authorized object URLs only after checking group membership.

Keep production Access values in Wrangler encrypted secrets (`wrangler secret put`) or dashboard encrypted secrets. Keep local values in the ignored `.dev.vars` file. OAuth credentials must live outside this repository. The account and D1 IDs in `wrangler.toml` are non-secret resource identifiers, not credentials.

## Data and API

`migrations/0001_initial.sql` is the schema migration currently checked in. Apply every migration in `migrations/` to each environment; seed data, when used locally, must remain local.

Important endpoints include:

- `GET /api/me`, `GET/POST /api/groups`, group updates/deletion, and owner-only member addition/listing (member removal/update is not implemented)
- `GET/POST /api/groups/:id/expenses`, `GET/PUT/DELETE /api/expenses/:id`
- `GET/POST /api/groups/:id/settlements`, `PUT/DELETE /api/settlements/:id`
- balances (raw and deterministic simplified debts), activity, versioned JSON export, group JSON/CSV export

Expense and settlement writes validate membership, supported two-decimal ISO currency, real calendar dates, safe integer values, participant uniqueness, and exact payer/split totals before using D1 `batch()` for atomic related writes. Supported currencies are USD, EUR, GBP, AUD, CAD, NZD, SGD, HKD, CHF, CNY, and INR; currencies with a different minor-unit exponent (for example JPY) are intentionally rejected. `client_operation_id` claims are scoped by mutation kind, authenticated user, and group and include a request hash. Updates and deletes require the loaded integer `version`, use conditional writes, and snapshot the previous state in `revisions`. Pairwise semantics are “from owes to”; debt simplification is deterministic. Every active expense and settlement currency is returned separately and is never netted or hidden by the group default.
Conditional mutations guard the parent and child statements in one D1 batch and then verify the resulting version. This avoids silent stale overwrites even where a D1 batch does not expose a convenient affected-row count; a failed post-batch version check returns `CONFLICT`.

The expense list supports bounded pagination and `q`, `person`, `category`, `from`, `to`, and `currency` filters. JSON responses use `{ error: { code, message } }` for structured failures.

## Client features and limitations

The app includes groups, owner/member access, multi-payer expense editing, equal/exact/percentage-basis-point/share allocation, expense history and deletion, multi-currency balances, partial settlements, activity, and exports. Percentages are entered as basis points totaling 10,000 to avoid persisted floating point. Exports read the complete active ledger internally rather than stopping at the UI page size, and CSV cells are protected against spreadsheet formula injection.

`public/manifest.webmanifest`, the SVG icon, and `public/sw.js` provide the installable PWA shell. The service worker uses a versioned, bounded allowlist for static shell assets, serves navigation with a cached `index.html` fallback (including deep expense routes), and never caches `/api`, Cloudflare Access paths, or mutation responses.

The app supports trusted-device offline capture for **new expenses only**. After a successful online visit, the unlocked browser profile stores the last verified identity, group/member snapshots, and recent group data in user-scoped IndexedDB. A new expense is written to a durable, leased IndexedDB outbox before any network attempt, then replayed with the same payload and `client_operation_id` once connectivity and Cloudflare Access are available. Pending rows show Waiting to sync, Syncing, Sign in to sync, or Sync failed and can be retried or discarded (with confirmation); hung writes time out and remain retryable. If an Access session expires, API calls return an AJAX-friendly 401, the shell shows an accessible reconnect action, and an online top-level reload goes back through Access. No reload is attempted while offline, and queued expenses remain in IndexedDB and resume after a successful Access visit. Offline edits, deletes, settlements, membership changes, exports, and other reads without a matching cached snapshot remain unavailable. Local cache access is not server authorization: replay still requires the normal Cloudflare Access session, and no local token bypasses it.

Settings can clear cached identity, groups, snapshots, and recent preferences without deleting pending or delivery-uncertain outbox operations. Those operations must be resolved through their queue controls. Logging out uses the app-domain top-level endpoint `/cdn-cgi/access/logout`; it warns when expenses are unsynced and does not expose or commit any token.

Remaining intentional MVP limitations are no offline editing/deletion/settlement/membership sync, no currency conversion, and no receipt upload UI. IndexedDB can be cleared by the browser or unavailable in private/restricted contexts; those conditions are surfaced rather than silently dropping queued expenses. The `attachments` table and optional `RECEIPTS` R2 binding remain an extension point; any future routes must check group membership before issuing object access. D1 migrations must be applied explicitly in each environment, and production Access policy configuration remains an operator responsibility.
