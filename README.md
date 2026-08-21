# BillSplit

A small, private BillSplit PWA built for Cloudflare Workers. It uses React/Vite for the mobile-first client, Hono for the API, D1 for relational data, and optional R2 attachment metadata. Financial values are integer minor units (for example, `1234` is USD 12.34) and currencies are kept separate.

## Development

Requirements: Node 20.9+ and npm. The intended package manager is npm (the lockfile is checked in).

```sh
npm install
npm run dev                 # Vite UI only
npm run typecheck
npm test
npm run build
```

For the reusable Playwright browser audit (production client build plus a
local Worker and isolated D1 fixture), run:

```sh
npm run test:e2e:audit
```

The harness uses Chromium from the preinstalled `/ms-playwright` cache, starts
`wrangler dev --env dev --local` on port `8788`, and persists its temporary D1
state under `/tmp/bill-split-playwright-d1` (the harness rejects any
`BILLSPLIT_E2E_PERSIST_DIR` outside a direct `/tmp/bill-split-playwright-*`
child and refuses to remove symlinks or non-directories). It runs migrations and
`tests/e2e/fixture.sql` locally only; it never uses `--remote`. Full-page
screenshots, Playwright attachments, and JSON findings are written under the
ignored `test-results/` and `playwright-report/` directories. Geometry findings
are collected before the audit fails: critical and major findings fail the test
after screenshots and reports are written, while minor project-policy findings
remain non-failing. The report separates validated
route/fixture coverage from actual violations; touch-target findings are the
project policy at mobile/tablet widths, not universal standards claims.

For an end-to-end Worker with local D1 and static assets:

```sh
npm run db:migrate:local
npm run db:seed
npx wrangler dev
```

Production defaults to `ENVIRONMENT=production` and has no development bypass. For local Worker development use the named Wrangler environment (`npx wrangler dev --env dev`) or explicitly provide `ENVIRONMENT=development`; only that exact value enables the local `X-Dev-Email` helper. The browser adds this helper only in a Vite development build. The `env.dev` D1 binding in `wrangler.toml` uses a clearly non-production placeholder UUID: local Wrangler creates isolated D1 state under the E2E `--persist-to` directory, while an accidental deploy of the dev environment cannot bind the production database. Keep `env.dev` local-only and do not replace that placeholder with a real resource ID. Production uses same-origin Clerk session cookies; BillSplit does not persist a bearer token.

## Cloudflare setup and deployment

1. Use the provisioned D1 database configured in `wrangler.toml` and apply its migrations:

   ```sh
   npx wrangler d1 create bill-split
   # copy its database_id into wrangler.toml
   npm run db:migrate:remote
   ```

2. Configure Clerk for the production origin `https://billsplit.laurenceputra.com`. Enable email verification-code sign-in and public signup; do not enable social sign-in for this application. Configure the custom session claim `{"primaryEmail":"{{user.primary_email_address}}"}`. Set these Worker configuration names outside this repository: `CLERK_PUBLISHABLE_KEY`, encrypted `CLERK_SECRET_KEY`, `CLERK_JWT_KEY`, and `CLERK_AUTHORIZED_PARTIES` (a comma-delimited allowlist containing the exact app origin). `CLERK_SECRET_KEY` is required by the installed Clerk backend client even when `CLERK_JWT_KEY` enables networkless token verification. Set `VITE_CLERK_PUBLISHABLE_KEY` in the Vite production build environment. The Worker derives the Clerk FAPI CSP source from `CLERK_PUBLISHABLE_KEY` using Clerk's supported publishable-key parser; no extra FAPI binding is required. Missing or malformed keys fail closed for external CSP sources while same-origin assets remain available. The Worker verifies session tokens locally with the Clerk JWT key and rejects tokens from unauthorized parties. Never place keys, credentials, tokens, or additional domains in this repository.

3. Deploy:

   Apply and verify all D1 migrations, including `0005_clerk_identity.sql`, **before** deploying this Worker. The deploy command does not apply migrations automatically; do not skip this ordering because the Worker references `users.clerk_user_id`.

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

Keep production Clerk values in Wrangler encrypted secrets or dashboard encrypted settings; in particular, set `CLERK_SECRET_KEY` with `wrangler secret put CLERK_SECRET_KEY`. Keep local values in the ignored `.dev.vars` file. OAuth credentials must live outside this repository. The account and D1 IDs in `wrangler.toml` are non-secret resource identifiers, not credentials.

## Data and API

All SQL files in `migrations/` are applied in order; `0003_ledger_total_limits.sql` installs authoritative D1 triggers that conservatively cap active gross expense-plus-settlement totals at `Number.MAX_SAFE_INTEGER` per group and currency, including concurrent inserts and relevant restores/updates. Seed data, when used locally, must remain local.

Important endpoints include:

- `GET /api/me`, `GET/POST /api/groups`, group updates/deletion, and owner-only member addition/listing (member removal/update is not implemented)
- `GET/POST /api/groups/:id/expenses`, `GET/PUT/DELETE /api/expenses/:id`
- `GET/POST /api/groups/:id/settlements`, `PUT/DELETE /api/settlements/:id`
- `GET/POST /api/groups/:id/scheduled-expenses`, `GET/PUT /api/scheduled-expenses/:id`, and pause/resume/cancel actions
- balances (raw and deterministic simplified debts), activity, versioned JSON export, group JSON/CSV export

Expense and settlement writes validate membership, supported two-decimal ISO currency, real calendar dates, safe integer values, participant uniqueness, and exact payer/split totals before using D1 `batch()` for atomic related writes. D1 ledger-limit triggers are authoritative for races and return structured `BALANCE_OVERFLOW`/422 errors; checked application arithmetic remains in place for legacy or imported data. Supported currencies are USD, EUR, GBP, AUD, CAD, NZD, SGD, HKD, CHF, CNY, and INR; currencies with a different minor-unit exponent (for example JPY) are intentionally rejected. `client_operation_id` claims are scoped by mutation kind, authenticated user, and group and include a request hash. Updates and deletes require the loaded integer `version`, use conditional writes, and snapshot the previous state in `revisions`. Pairwise semantics are “from owes to”; debt simplification is deterministic. Every active expense and settlement currency is returned separately and is never netted or hidden by the group default.
Conditional mutations guard the parent and child statements in one D1 batch and then verify the resulting version. This avoids silent stale overwrites even where a D1 batch does not expose a convenient affected-row count; a failed post-batch version check returns `CONFLICT`.

The expense list supports bounded pagination and `q`, `person`, `category`, `from`, `to`, and `currency` filters. JSON responses use `{ error: { code, message } }` for structured failures.

Scheduled expenses are recurring templates, not ledger rows. From a group or friend ledger, choose **Schedule expense** and configure a custom daily, weekly, monthly, or yearly interval. Weekly schedules require one or more weekdays; an optional end date is inclusive. The creator timezone defaults from the browser and can be edited as an IANA timezone. The form previews the next dates before saving. A Worker cron generates ordinary expenses only when their occurrence is due, so future templates do not affect balances; generated expenses remain in the ledger even if the template is later edited, paused, or cancelled. Edits are online-only and apply only to future occurrences. Schedules show their status, next occurrence, and any blocked reason, and can be paused, resumed, or cancelled online. Schedule mutations never enter the expense outbox. Cron catch-up is bounded to 20 occurrences per invocation and 20 occurrences per template, processed round-robin so a stale template cannot starve other schedules. When a cursor reaches a cap it remains due and is continued by later invocations; dates are not silently skipped, and operators should edit, pause, or cancel a template if historical catch-up is not wanted.

## Client features and limitations

The app includes groups, owner/member access, multi-payer expense editing, equal/exact/percentage-basis-point/share allocation, expense history and deletion, multi-currency balances, partial settlements, activity, and exports. Percentages are entered as basis points totaling 10,000 to avoid persisted floating point. Exports read the complete active ledger internally rather than stopping at the UI page size, and CSV cells are protected against spreadsheet formula injection.

`public/manifest.webmanifest`, the SVG icon, and `public/sw.js` provide the installable PWA shell. The service worker uses a versioned, bounded allowlist for static shell assets, serves navigation with a cached `index.html` fallback (including deep expense routes), and never caches `/api`, authentication paths, or mutation responses.

The app supports trusted-device offline capture for **new expenses only**. After a successful online visit, the unlocked browser profile stores the last verified identity, group/member snapshots, and recent group data in user-scoped IndexedDB. A new expense is written to a durable, leased IndexedDB outbox before any network attempt, then replayed with the same payload and `client_operation_id` once connectivity and a Clerk session are available. Pending rows show Waiting to sync, Syncing, Sign in to sync, or Sync failed and can be retried or discarded (with confirmation); hung writes time out and remain retryable. If a Clerk session expires, API calls return an AJAX-friendly 401 and the shell shows an accessible reconnect action. No reload is attempted while offline, and queued expenses remain in IndexedDB and resume after a successful Clerk sign-in. Offline edits, deletes, settlements, membership changes, exports, and other reads without a matching cached snapshot remain unavailable. Local cache access is not server authorization: replay still requires the normal Clerk session, and no local token bypasses it.

Settings can clear cached identity, groups, snapshots, and recent preferences without deleting pending or delivery-uncertain outbox operations. Those operations must be resolved through their queue controls. Logging out first quiesces mutations and clears local private data, then asks Clerk to end the session and redirect to `/`; it warns when expenses are unsynced and does not expose or commit any token. State-changing API requests and destructive logout use the Web Locks API when available, so supported Chromium browsers and installed PWAs wait for every dispatched mutation to settle before local data is cleared. Browsers without Web Locks still block new mutations through the same-tab registry plus the storage/BroadcastChannel session barrier, but cannot observe a fetch still in flight in another tab; users should finish logout in a Web Locks-capable browser when that cross-tab guarantee matters.

Remaining intentional MVP limitations are no offline editing/deletion/settlement/membership sync, no offline schedule management, no currency conversion, and no receipt upload UI. Scheduled templates are fetched online and are not cached for offline use. IndexedDB can be cleared by the browser or unavailable in private/restricted contexts; those conditions are surfaced rather than silently dropping queued expenses. The `attachments` table and optional `RECEIPTS` R2 binding remain an extension point; any future routes must check group membership before issuing object access. D1 migrations must be applied explicitly in each environment, and production Clerk configuration remains an operator responsibility.
