# BillSplit

A small, private BillSplit PWA built for Cloudflare Workers. It uses React/Vite for the mobile-first client, Hono for the API, D1 for relational data, and optional R2 attachment metadata. Financial values are integer minor units (for example, `1234` is USD 12.34) and currencies are kept separate.

## Development

Requirements: Node 22+ and npm. The intended package manager is npm (the lockfile is checked in).

```sh
npm install
npm run dev                 # Vite UI only
npm run typecheck
npm test
npm run build
```

Vitest is split into required fast unit and local-D1 integration tiers while
`npm test` remains the complete non-E2E suite:

```sh
npm run test:unit         # fast fake-D1/unit and source-contract checks
npm run test:integration  # focused real local-D1 migration and summary checks
npm test                  # complete required non-E2E suite
npm run test:performance  # optional large-workload and query-plan checks
npm run test:all          # required suite plus performance checks
```

Cloudflare Workers Builds runs `npm run test:unit` before the production
bundle build; it does not run the optional performance tier. GitHub Actions
runs the unit/build and local-D1 integration jobs in parallel for pull requests
and pushes to `main`. Playwright remains a separate E2E suite.

For a Clerk-backed Vite build, copy `.env.example` to the mode-specific local
file and set the publishable key from your Clerk instance:

```sh
cp .env.example .env.production.local
```

The `.env.production.local` file is ignored. Do not put Worker secrets in Vite
environment files.

The browser checks include the existing Chromium geometry audit plus focused
keyboard and accessibility-semantic checks:

```sh
npm run test:e2e
npm run test:e2e:audit
```

The runtime image currently provides Chromium only (`/ms-playwright`); no
WebKit project is enabled in default CI. Add a separately provisioned,
optional WebKit project only when that browser/runtime is available.

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

The production config sets `ENVIRONMENT=production` and has no development
bypass. The tracked `wrangler.toml` defaults to `ENVIRONMENT=development`; use
the named Wrangler environment (`npx wrangler dev --env dev`) or explicitly
provide that value for local Worker development. Only the exact development
value enables the local `X-Dev-Email` helper, and the browser adds this helper
only in a Vite development build. The tracked config is deliberately local-only:
it has no Cloudflare account, production D1, rate-limit, or custom-domain
configuration. Its `env.dev` D1 binding uses a non-production placeholder UUID,
and local Wrangler creates isolated D1 state under the E2E `--persist-to`
directory. It also deliberately has no Cloudflare rate-limit binding; the Worker
permits a missing limiter only when `ENVIRONMENT` is exactly `development` or
`test`. Keep `env.dev` local-only. Production uses same-origin Clerk session
cookies; BillSplit does not persist a bearer token. Clerk is used only to
bootstrap the application session. Production uses the `__Host-billsplit_session`
HttpOnly cookie with a 30-day inactivity window and no absolute lifetime; the
server stores only a SHA-256 hash of its 256-bit random value. `GET /api/me`
does not renew that window. The client sends explicit activity only when the
visible app is opened or a trusted interaction occurs, and the server limits
renewal to once per 24 hours. Mutations require same-origin metadata and the
host-only `billsplit_csrf` cookie/header double-submit check. Development uses
the separate `billsplit_session` cookie name.

## Cloudflare setup and deployment

Production commands require the ignored `wrangler.deploy.toml`; the tracked
`wrangler.toml` must not be used for production. A clone can create its own
Cloudflare resources without changing tracked files:

### Workers Builds dashboard setup

For the initial production setup, connect the existing Cloudflare Worker to the
GitHub repository in **Workers & Pages → the Worker → Builds**. Configure the
build as follows:

- Production branch: `main`
- Root directory: the repository root (`/`)
- Build command: `npm run cf:build`
- Deploy command: `npm run cf:deploy`
- Build secret: `WRANGLER_DEPLOY_TOML_BASE64`, containing the base64 encoding of
  the complete production `wrangler.deploy.toml` (the file itself remains
  ignored and must never be committed)
- Required Worker runtime variables in **Worker → Settings → Variables &
  Secrets**: `CLERK_PUBLISHABLE_KEY` and `CLERK_JWT_KEY`. These are
  dashboard-managed variables, not build variables or secrets. Provision and
  verify both before the first deploy; `--keep-vars` only preserves values that
  already exist in the Worker dashboard.
- Build variable: `VITE_CLERK_PUBLISHABLE_KEY`, set to the matching Clerk
  publishable key
- Builds API token: select the already-created custom Cloudflare API token in
  the dashboard's **API token** setting for Builds. Scope it to the account
  with Workers Scripts Edit and D1 Edit permissions; do not add it as a build
  variable or build secret.

Keep non-production branch builds disabled while these production build
secrets and the selected API token are attached. A preview cannot safely share
them: previews require a separately isolated Worker, D1 database, config,
Clerk setup, and credentials. Branch code cannot be trusted with production
credentials. Only the `main` production build is allowed to run `cf:deploy`; the
wrapper also enforces both Cloudflare's `WORKERS_CI=1` marker and
`WORKERS_CI_BRANCH=main`, so preview and other branch builds cannot apply
production migrations or deploy the production Worker.

Keep runtime secrets such as `CLERK_SECRET_KEY` and
`IDENTITY_TOMBSTONE_KEY` managed by the Worker dashboard/Wrangler secrets, not
as build variables and never in the base64 config secret. `cf:build` validates
the supplied config and frontend key, runs the fast unit tier, and builds the bundle;
`cf:deploy` validates the config again, dry-runs Wrangler, applies remote D1
migrations, and deploys the already-built `dist/` without rebuilding.
The base64 config must contain the existing `[secrets].required` declaration for
both runtime secrets, but must not contain assignments for either secret.
The preparer checks the required production fields but deliberately does not
parse all TOML syntax; Wrangler's inherited-output dry-run is the authoritative
malformed-TOML check and runs before any migration. The deploy wrapper also
removes `WRANGLER_CI_OVERRIDE_NAME`, so Wrangler cannot replace the Worker name
from `wrangler.deploy.toml`. Any Workers CI override mismatch fails during
preparation, before the dry-run or any migration. Worker name and production
origin are derived from the decoded TOML;
the origin is cross-checked against `CLERK_AUTHORIZED_PARTIES` and the route
hostname. On a guarded `main` build, preparation writes the validated config to
both ignored `wrangler.deploy.toml` and the ephemeral root `wrangler.toml` that
Workers Builds reads, allowing the connected Worker name check to use the
validated config; the tracked local config is never changed in the repository.

To create the single-line build secret value on Linux, use
`base64 -w0 wrangler.deploy.toml` and paste the result into the dashboard (use
`base64 wrangler.deploy.toml | tr -d '\n'` on systems whose `base64` has no
`-w` option).

1. Clone the repository, install dependencies, and authenticate Wrangler:

   ```sh
   git clone <repository-url>
   cd bill-split
   npm install
   npx wrangler login
   ```

2. Create a D1 database for the installation. Keep the returned database name
   and ID for the production config:

   ```sh
   npx wrangler d1 create bill-split
   ```

3. Create the ignored production config and replace every placeholder with the
   Worker name, account ID, D1 name and ID from the previous command, native
   rate-limit namespace ID, and your chosen custom-domain hostname:

   ```sh
   cp wrangler.deploy.toml.example wrangler.deploy.toml
   # edit wrangler.deploy.toml
   ```

   Create the account-scoped native rate-limit namespace in the Cloudflare
   dashboard or API and copy its ID into the config; the installed Wrangler
   does not provide a rate-limit namespace creation command.

   The selected Cloudflare account must have an active zone for the custom
   domain. The chosen hostname must not already have a conflicting DNS record,
   such as a CNAME; remove or replace conflicting DNS before provisioning the
   Wrangler custom domain route.

   Set `CLERK_AUTHORIZED_PARTIES` to the exact chosen HTTPS origin, such as
   `https://your-bill-split.example`. For the dashboard-managed setup, leave
   `CLERK_PUBLISHABLE_KEY` and `CLERK_JWT_KEY` out of the ignored config; the
   Worker runtime variables above supply them. They may alternatively be
   included as non-secret `[vars]` values, in which case production validation
   requires a live publishable key matching `VITE_CLERK_PUBLISHABLE_KEY` and a
   valid PEM public key for `CLERK_JWT_KEY`. `CLERK_JWT_KEY` is a public
   verification key, not a secret; preserve its PEM formatting when pasting it.
   Configure that origin in Clerk, including email verification-code sign-in,
   public signup, the custom session claim
   `{"primaryEmail":"{{user.primary_email_address}}"}`, and the allowed web
   origins. Do not enable social sign-in unless the deployment is changed to
   support it.

4. Set the encrypted Clerk secrets with the production config selected. The
   `[secrets].required` declaration in the example names the required secrets
   but never contains their values:

   ```sh
    npx wrangler secret put CLERK_SECRET_KEY --config wrangler.deploy.toml
    npx wrangler secret put IDENTITY_TOMBSTONE_KEY --config wrangler.deploy.toml
    npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.deploy.toml
    npx wrangler secret put PUSH_SUBSCRIPTION_ENCRYPTION_KEY --config wrangler.deploy.toml
    ```

   `IDENTITY_TOMBSTONE_KEY` is a stable production secret used only for keyed
   HMAC-SHA-256 deletion tombstones; do not derive it from or rotate it with a
    Clerk secret. `CLERK_SECRET_KEY` is required by the installed Clerk backend
   client even when `CLERK_JWT_KEY` enables networkless token verification.
   Set the same `VITE_CLERK_PUBLISHABLE_KEY` in `.env.production.local` before
   building. Never put keys, credentials, tokens, or additional domains in
    tracked files.

    Push delivery also requires the P-256 VAPID public key and contact value in
    `[vars]`, matching `VAPID_PRIVATE_KEY`. The encryption key protects stored
     endpoint and browser-key material. Create the notification and dead-letter
     queues named in `wrangler.deploy.toml`; the Worker remains cleanly disabled
     until all push secrets and the queue binding are present. Notification
     outbox history is retained for 30 days and purged in bounded Cron work;
       transient push failures retry the current Queue message (preserving its
       attempt count) four times after the initial send attempt; Queue then
       applies its configured dead-letter policy. D1 records the same five total
       provider attempts and logs a terminal delivery failure. Terminal provider
       failures are acknowledged rather than retried. If another recipient page
       remains, the consumer enqueues a fresh continuation message before that
       acknowledgement, so pagination has its own Queue retry budget and cannot
       be stranded behind a terminal page failure.

5. Apply and verify all remote migrations before deploying:

   ```sh
   npm run db:migrate:remote
   ```

   The migration script explicitly selects `wrangler.deploy.toml`; it fails if
   that ignored file has not been created.

6. Validate the production bundle and bindings, then deploy:

   The local `npm run deploy` and `npm run deploy:dry-run` commands build the
   client, then run `npm run validate:deploy` against the existing ignored
   production config before invoking Wrangler. That validation requires the
   live `VITE_CLERK_PUBLISHABLE_KEY` from the shell or
   `.env.production.local` and cross-checks any TOML publishable key. The
   `cf:deploy` command above is the guarded Workers Builds wrapper; it decodes
   and validates the build-supplied config, then dry-runs, migrates, and deploys
   in that order. Both local deploy commands and the CI wrapper pass
   `--keep-vars`: this preserves pre-existing dashboard-managed runtime
   variables omitted from the TOML, including `CLERK_PUBLISHABLE_KEY` and
   `CLERK_JWT_KEY`; it does not create or verify them. Operators must provision
   and verify both dashboard values before the first deploy because the offline
   deployment preflight cannot inspect dashboard state. If either is included
   as a non-secret TOML variable instead, validation checks it before
   deployment. Config values are updated from the file, while any additional
   dashboard-managed plaintext variables are not deleted. Secrets are never
   deleted by a deployment.

   ```sh
   npm run deploy:dry-run
   npm run deploy
   ```

   Deploy only after remote migrations are applied and verified. The Worker
   expects the complete schema, including the latest identity-tombstone
   migration; deployment does not apply D1 migrations. The production config
   is ignored and must be recreated locally when needed; never commit it.

Wrangler serves `dist` through the Workers Static Assets binding and routes `/api/*` to Hono. API errors are returned by Hono and are not hidden by SPA fallback. Do not put secrets in `wrangler.toml`; use `wrangler secret put` or the dashboard. Add this optional binding when receipts are enabled:

```toml
[[r2_buckets]]
```

The schema already includes attachment metadata. Receipt upload/download is deliberately not part of the core UI; an implementation should generate short-lived authorized object URLs only after checking group membership.

Keep `CLERK_SECRET_KEY` and `IDENTITY_TOMBSTONE_KEY` in Wrangler encrypted
secrets. Keep `CLERK_AUTHORIZED_PARTIES` and the account, D1, rate-limit, and
domain infrastructure settings in the ignored production config. The
`CLERK_PUBLISHABLE_KEY` and `CLERK_JWT_KEY` values may instead be managed as
Worker dashboard runtime variables; `--keep-vars` preserves them when omitted
from that config. They may also be included as non-secret `[vars]` values and
are then validated before deployment. Keep local-only values in ignored files.
OAuth credentials must live outside this repository. Do not put production
settings in `wrangler.toml`.

## Data and API

Active group members may save or update one optional shared party split default
from new one-off expense creation, using equal, percentage (integer basis points
totaling 10,000), or shares (exact is not allowed). Group owners retain admin
management and are the only members who may clear it. `GET /api/groups/:id`
returns it as `splitDefault`; `PUT` and `DELETE` `/api/groups/:id/split-default`
manage it online. New one-off expenses and scheduled templates copy the
arrangement, while existing records and saved schedules are not changed by
later default edits. If a saved arrangement names a removed member, it is
retained and new entries fall back to equal across the current active members
until an active member updates or repairs it. Individual expenses can
override the copied arrangement and reset to the current party default.
Suggestions are online-only
and use the authenticated user's latest three active, non-scheduled-occurrence
expenses; they appear only when a repeated arrangement differs from the
current default.

All SQL files in `migrations/` are applied in order; `0003_ledger_total_limits.sql` installs authoritative D1 triggers that conservatively cap active gross expense-plus-settlement totals at `Number.MAX_SAFE_INTEGER` per group and currency, including concurrent inserts and relevant restores/updates. `0013_projection_layer.sql` adds compact gross totals and per-person net projections in a pending state; existing groups are never published as ready by migration. Migration `0024_incremental_projection_totals.sql` stages existing groups as pending and installs hybrid overflow guards that use O(1) primary-key totals only when a group is ready. Bounded per-group maintenance later builds and atomically publishes those totals. The authoritative tables remain `expenses`, `payers`, `splits`, and `settlements`; pending, dirty, missing, and failed groups use direct aggregation until bounded maintenance publishes readiness, while ready groups are maintained incrementally from exact old/new payer, split, and settlement contributions. The legacy `projection_state` records mutation count, last reconciliation time, and a reconciliation-due flag for compatibility; current readiness and maintenance do not use a mutation-count threshold. Full recomputation is reserved for bounded Cron backfill/reconciliation. `0014_projection_indexes.sql` adds stable keyset and person-leading indexes, `0015_audit_actor_snapshot.sql` adds non-email actor snapshots, `0016_projection_readiness_reset.sql` safely repairs installations that applied the earlier ready-state projection migration before deploying the Worker, and `0017_cleanup_indexes.sql` removes only exact duplicate indexes. `0018_category_preferences.sql` adds private, per-user learned categories keyed by `trim(description)` followed by lowercase; explicitly chosen categories remain preferences even when their originating schedule is cancelled. `0019_group_membership_events.sql` records owner transfers, self-leaves, and owner removals with actor/name snapshots (never email) and enforces one active owner per group. `0020_account_deletion.sql` adds the user soft-delete marker needed to retain financial/audit foreign-key anchors while pseudonymizing personal identity. `0021_deleted_identity_tombstones.sql` stores keyed HMAC-SHA-256 email/Clerk identity tombstones so a deleted account cannot be silently relinked after live identity fields are cleared. `0022_application_sessions.sql` adds opaque server-managed sessions, and `0023_group_split_defaults.sql` adds one optional persisted split arrangement per group. Seed data, when used locally, must remain local.

The migration 0024 rollout details and current readiness guarantees are in the
Operations section below; it is staged per group and does not perform a
whole-database totals rebuild.

Migration `0025_expense_suggestion_lookup.sql` adds the partial lookup index
used for private split-default suggestions.

The older projection wording in the preceding historical paragraph is retained
for migration context only. The current Worker uses the monthly/checkpoint
tables and readiness rules documented below; it does not use a mutation-count
threshold or read `group_balance_projection`. Migration 0024 replaces the
legacy 0003 aggregate triggers with hybrid guards; its dirty triggers preserve
safe fallback behavior for old Workers.

The current implementation uses monthly/checkpoint summaries described in
Operations below. The legacy projection names mentioned in older deployment
notes are retained only for compatibility and are not runtime read sources.

Important endpoints include:

- `POST /api/session/bootstrap`, `GET /api/me`, explicit `POST /api/session/activity`, current/all-device logout (`DELETE /api/session`, `DELETE /api/sessions`), `GET/POST /api/groups`, group updates/deletion, owner-only member administration/removal, owner transfer (`POST /api/groups/:id/transfer-ownership`), member self-leave (`POST /api/groups/:id/leave`), historical settlement participants (`GET /api/groups/:id/historical-participants`), and in-app email-targeted invitations (`/api/groups/:id/invitations`, `/api/invitations`)
- `DELETE /api/account` with the exact JSON confirmation `{"confirmation":"DELETE MY ACCOUNT"}`. Deletion is blocked with a structured conflict containing only the active owned-group count. Eligible deletion soft-leaves non-owned memberships, revokes pending invitations, pseudonymizes every invitation history row addressed to the deleted email, removes private category/idempotency data, clears the Clerk linkage, and pseudonymizes the user/person while retaining financial rows and audit actor-name snapshots for referential integrity.
- `GET/POST /api/groups/:id/expenses`, `GET/PUT/DELETE /api/expenses/:id`
- `GET /api/notifications/status`, `GET /api/notifications/preferences`, authenticated preference updates, and authenticated push subscription upsert/delete under `/api/notifications/subscription`
- `GET/POST /api/groups/:id/settlements`, `GET/PUT/DELETE /api/settlements/:id`, and versioned restore endpoints
- `GET/POST /api/groups/:id/scheduled-expenses`, `GET/PUT /api/scheduled-expenses/:id`, and pause/resume/cancel actions
- balances (raw and deterministic simplified debts), activity, versioned JSON export, group JSON/expense CSV/settlement CSV export

Expense and settlement writes validate membership, supported two-decimal ISO currency, real calendar dates, safe integer values, participant uniqueness, and exact payer/split totals before using D1 `batch()` for atomic related writes. Active-user and active-participant predicates are repeated inside mutation batches, so a removal racing a write cannot grant access or introduce a removed participant. Removed participants remain valid settlement endpoints for clearing outstanding balances, while new expenses and schedules require active participants. D1 ledger-limit triggers are authoritative for races and return structured `BALANCE_OVERFLOW`/422 errors; checked application arithmetic remains in place for legacy or imported data. Supported currencies are USD, EUR, GBP, AUD, CAD, NZD, SGD, HKD, CHF, CNY, and INR; currencies with a different minor-unit exponent (for example JPY) are intentionally rejected. `client_operation_id` claims are scoped by mutation kind and authenticated user/group and include a request hash. Updates and deletes require the loaded integer `version`, use conditional writes, snapshot the previous state in `revisions`, and append actor user/person IDs plus a name snapshot (never email) with before/after records to `audit_events` in the same batch. Group ownership transfer and member self-leave are serialized D1 operations with repeated authorization predicates, soft-removal, pending-invitation revocation, and append-only non-email snapshots in `group_membership_events`; only a current owner can transfer to an active linked member, and owners must transfer or delete before leaving. Legacy audit rows fall back to `Unknown user` when no current person is available. Audit history is available at `GET /api/groups/:id/audit` with bounded pagination. Active-group financial detail, including soft-deleted expenses and settlements, is permanent; deleted-group cleanup remains bounded. Deleted transaction detail is restorable for 30 days.
Conditional mutations guard the parent and child statements in one D1 batch and then verify the resulting version. This avoids silent stale overwrites even where a D1 batch does not expose a convenient affected-row count; a failed post-batch version check returns `CONFLICT`.

Historical settlement participants are authorized separately from active membership. Removed people and deleted accounts remain available for outstanding settlement endpoints with `Removed` or `Deleted account` labels, while new expenses and schedules continue to accept active members only.

The expense, settlement, scheduled-expense, and audit lists support bounded opaque keyset pagination. Expense and settlement pages are ordered by `(expense_date|settlement_date, created_at, id)`, scheduled templates by `(created_at, id)`, and audit pages by `(occurred_at, id)`, all descending with the ID tie-breaker. Responses expose `nextCursor`; an `offset` on expense, settlement, or audit endpoints returns structured `400 INVALID_PAGINATION` rather than being ignored. Offset pagination remains explicitly supported only on scheduled-expense list requests for one deployed-client grace release so old cached PWA clients do not repeat page one. The current client always uses the cursor. Expense search accepts description/notes, member, category, date range, and currency filters and rejects a complete UTF-8 LIKE pattern over 50 bytes (including wildcards). JSON responses use `{ error: { code, message } }` for structured failures.

Scheduled expenses are recurring templates, not ledger rows. From a group or friend ledger, choose **Add expense**, leave it one-time, or turn on **Repeat this expense** to configure a custom daily, weekly, monthly, or yearly interval. Weekly schedules require one or more weekdays; an optional end date is inclusive. The creator timezone defaults from the browser and can be edited as an IANA timezone. The form previews up to three localized next dates and explains whether the schedule continues until paused/cancelled or through its end date. A Worker cron generates ordinary expenses only when their occurrence is due, so occurrences affect balances only when posted; future templates do not affect balances. Generated expenses remain in the ledger even if the template is later edited, paused, or cancelled. Edits are online-only and apply only to future occurrences. Schedules show their status, next occurrence, and any blocked reason, and can be paused, resumed, or cancelled online. Schedule mutations never enter the expense outbox. Cron catch-up is bounded to 20 occurrences per invocation and 20 occurrences per template, processed round-robin so a stale template cannot starve other schedules. When a cursor reaches a cap it remains due and is continued by later invocations; dates are not silently skipped, and operators should edit, pause, or cancel a template if historical catch-up is not wanted. The same scheduled handler performs bounded deleted-group cleanup, generation, and projection backfill and logs structured outcomes. Deleted-group notification events and deliveries are drained child-first in bounded retention pages before the group parent is physically purged. Generated occurrence tombstones remain after a generated expense purge, preventing Cron from regenerating that occurrence; transaction idempotency tombstones are retained where needed for safe retries.
The former `/groups/:id/scheduled-expense/new` URL redirects to the combined expense form; existing schedule edit URLs remain available for recurring schedule management.

## Client features and limitations

The app includes groups, owner/member access, multi-payer expense editing, equal/exact/percentage-basis-point/share allocation, expense and settlement history/deletion/restoration, multi-currency balances, partial settlements, activity, and exports. Group owners can rename a group, change its default currency without conversion, or soft-delete it after a typed-name confirmation; these settings are online-only. Owners can transfer ownership only to an active linked member; non-owners can leave after confirmation, while owners must transfer first or delete the group. Group expenses can be filtered by search, member, category, date range, and currency. Filters use namespaced URL parameters, preserve unrelated route parameters, and reset cursor pagination when applied. Percentages are entered as basis points totaling 10,000 to avoid persisted floating point. Verified users see matched pending invitations in the app and can accept or reject them; owners invite by email, see expiry/status, revoke, retry, transfer ownership, and remove members with confirmation. There is no email copy or invitation-link UI. Removed people are excluded from new expenses and schedules but remain usable in settlement flows and are marked where historical data lacks an active member.

Expense, settlement, scheduled-expense, activity, and audit lists use opaque keyset cursors with Load more or bounded cursor-following. The first IndexedDB page remains an offline presentation and never implies that the ledger is complete; server-side expense filtering is disabled offline because filtered pages are not cached. New settlements default to today but allow a selected date, which is preserved while suggestions refresh and when resetting the suggested participants/amount. Detail pages include safe actor/timestamp audit differences, settlement details, and 30-day tombstones with version-checked restore; active-group financial rows remain available after soft deletion, while deleted-group purge removes the group and its detail in bounded work. Group JSON, separate expense CSV, separate settlement CSV, and account-wide JSON exports are assembled page-by-page with progress, cancellation, download errors, File System Access where available, and a Blob fallback. CSV formula protection remains server-side.

`public/manifest.webmanifest`, the SVG icon, and `public/sw.js` provide the installable PWA shell. The service worker uses a versioned, bounded allowlist for static shell assets, serves navigation with a cached `index.html` fallback (including deep expense routes), and never caches `/api`, authentication paths, or mutation responses.

The app supports trusted-device offline capture for **new expenses only**. After a successful online visit, the unlocked browser profile stores one atomic offline-trust record bound to the application's server-provided `idleExpiresAt`, the verified internal identity, and the current Clerk user ID. Legacy split identity records never establish offline trust; explicit logout, account changes, or an expired idle boundary durably revoke the record. A new expense is written to a durable, leased IndexedDB outbox before any network attempt, then replayed with the same payload and `client_operation_id` once connectivity and an application session are available. Pending rows show Waiting to sync, Syncing, Sign in to sync, or Sync failed and can be retried or discarded (with confirmation); hung writes time out and remain retryable. If verification is unavailable, the shell shows bounded retry guidance rather than claiming the user is signed out. During phone sleep/wake, matching cached private data remains on the current route while the application session is checked; server mutations and outbox replay wait for authoritative verification. No reload is attempted while offline, and queued expenses remain in IndexedDB and resume after an application-session bootstrap. Offline edits, deletes, settlements, membership changes, exports, and other reads without a matching cached snapshot remain unavailable. Local cache access is not server authorization: replay still requires the server's application session, and no local token bypasses it.

Push notifications are an optional, per-device enhancement. The Settings control requests browser permission only from the explicit **Enable notifications** button; startup and foreground reconciliation never prompt. Each account may have at most **10 active push subscriptions**; refreshing the same endpoint is idempotent, while an endpoint moving between accounts must fit the destination cap. Account-wide content preferences cover money changes, scheduled events, and generic versus detailed lock-screen text (generic is the default); enabling or disabling a device revokes that device's active subscription while retaining its delivery history for bounded maintenance. A cross-account endpoint transfer likewise revokes the old subscription and creates a new subscription ID, so old deliveries remain isolated from the new account. Subscription credentials are sent only over the authenticated same-origin application session and are encrypted at rest by the Worker. Only HTTPS endpoints from Apple Web Push (`web.push.apple.com`), Google FCM (`fcm.googleapis.com`), or Mozilla desktop push (`updates.push.services.mozilla.com` / `push.services.mozilla.com`) are accepted. Logout/account changes write a separate token-free local revocation marker that the service worker checks against the recipient's internal user ID. The service worker also validates notification routes, focuses or opens the app on click, and maintains a small local activity badge where the platform supports App Badging. The badge is not an exact cross-device unread count and is cleared when History is opened.

On iOS/iPadOS, Web Push requires an HTTPS site added to the Home Screen and opened as the standalone PWA. The app explains this installation gate instead of requesting permission from a browser tab. App Badging is used when the installed PWA exposes it; unsupported browsers show an unavailable state without calling the API. Background Sync is feature-detected as a wake-up hint for queued new expenses only. It never sends an expense from the service worker because the authenticated application-session cookie, internal-user binding, lease protocol, and logout barrier remain authoritative in the foreground; foreground replay is always the fallback.

Settings can clear cached identity, groups, snapshots, and recent preferences without deleting pending or delivery-uncertain outbox operations. Those operations must be resolved through their queue controls. Logging out first revokes the current server application session while online, then quiesces mutations and clears private cache data while preserving the user-scoped expense outbox; queued expenses cannot replay until that same internal account is verified again. Clerk is then asked to end the session and redirect to `/`; a failed revocation leaves local data intact. All-device logout revokes every application session. State-changing API requests and destructive logout use the Web Locks API when available, so supported Chromium browsers and installed PWAs wait for every dispatched mutation to settle before local data is cleared. Browsers without Web Locks still block new mutations through the same-tab registry plus the storage/BroadcastChannel session barrier, but cannot observe a fetch still in flight in another tab; users should finish logout in a Web Locks-capable browser when that cross-tab guarantee matters.

### Push notification provisioning

Apply migrations `0026_notifications.sql` and `0027_notification_maintenance_indexes.sql` before enabling delivery. Create the
notification queue and dead-letter queue named in the production config, then
set the following values in Worker runtime configuration (never in Vite files
or tracked config):

- `VAPID_PRIVATE_KEY`: encrypted Worker secret for the P-256 VAPID key.
- `PUSH_SUBSCRIPTION_ENCRYPTION_KEY`: encrypted Worker secret used to protect
  browser endpoints and key material at rest.
- `VAPID_PUBLIC_KEY`: the matching URL-safe P-256 public key in `[vars]`.
- `VAPID_CONTACT`: a `mailto:` contact in `[vars]`.

The example deployment config declares these secrets and queue bindings, but
contains placeholders only. Delivery stays disabled until the queue, all VAPID
values, and the encryption key are present. Queue messages contain only opaque
event IDs; the Worker resolves recipients and current preferences from D1 and
includes a bounded internal route plus recipient identity in the encrypted push
payload. No Clerk token is stored by the client, service worker, or push tables.
Expired or revoked push subscriptions are removed only by bounded Cron purge
work, never by queue delivery. Each 15-minute Cron run first removes at most
100 delivery rows belonging to expired/revoked subscriptions, then removes at
most 100 of those subscriptions only when no delivery rows remain. Terminal
delivery retention and completed-event retention are each capped at 100 rows
per run, and the maintenance uses a fixed set of five D1 statements; no parent delete
relies on an unbounded foreign-key cascade. The notification Queue consumer uses
`max_batch_size = 1`: one page is capped at three recipients and stays within
the documented 18-query worst-case D1 budget.
Account deletion is separate from Clerk account management: the server deletion succeeds first and writes an identity-bound, non-sensitive pending-deletion marker outside IndexedDB. The app processes that marker before private hydration; a `server-pending` marker retries the authenticated, idempotent server DELETE with the marker's exact Clerk ID in `X-BillSplit-Expected-Clerk-User-Id`, and never clears local data or calls Clerk until the server commit is confirmed. The Worker requires both the application session and a fresh matching Clerk identity, then revokes all application sessions atomically with repository deletion. It then clears all local BillSplit data and calls the installed Clerk client's typed `UserResource.delete()` API. If the session expires or the user signs out after server/local cleanup, the marker remains and the app requires sign-in to the same Clerk account before provider deletion; only a confirmed `provider-deleted` marker may be cleared while signed out. Actor-name snapshots in financial audit and membership history are intentionally retained without email/contact details. Signed Clerk deletion/disable webhooks are intentionally deferred until a verified webhook API and secret are available; no pseudo-signature validation is used.

Remaining intentional MVP limitations are no offline editing/deletion/settlement/membership sync, no offline schedule management, no currency conversion, and no receipt upload UI. Scheduled templates are fetched online and are not cached for offline use. IndexedDB can be cleared by the browser or unavailable in private/restricted contexts; those conditions are surfaced rather than silently dropping queued expenses. The `attachments` table and optional `RECEIPTS` R2 binding remain an extension point; any future routes must check group membership before issuing object access. D1 migrations must be applied explicitly in each environment, and production Clerk configuration remains an operator responsibility.

### Rate limiting

The Worker uses Wrangler 4.86's native `[[ratelimits]]` binding; it does not use
D1 or a third-party limiter. Cloudflare native limits are enforced per location
and are eventually consistent, so they provide best-effort abuse mitigation,
not a hard global invariant. The production binding is `RATE_LIMITER` with an
account-scoped namespace configured in the ignored production file. Local
development has no rate-limit binding; a missing limiter is permitted only when
`ENVIRONMENT` is exactly `development` or `test`. Each authenticated internal
user ID gets a separate operation bucket, limited to five calls per minute at
each location, for group creation,
friend creation, invitation creation, invitation accept/reject, and push
subscription enrollment. The Worker
returns structured `429 RATE_LIMITED` JSON with `Retry-After: 60` when a limit
is exceeded.

Protected production routes fail closed with `503 RATE_LIMITER_UNAVAILABLE` if
the binding is missing or unavailable. Development and test environments may
use the deterministic binding or the explicit exact-value development/test
bypass; this bypass is never enabled for production. Expense, scheduled
expense, and settlement writes—including offline idempotent expense replay—are
intentionally not rate limited.

### Operations

Migration 0024 is a hybrid replacement of the legacy 0003 guards. Existing groups start
pending in `ledger_summary_state` and use authoritative fallback reads while
bounded maintenance scans immutable expense/settlement IDs into compact
verification rows. Generation CAS, leases, retry metadata, and per-month
failure isolation make bootstrap resumable. Every fully verified active month
folds into `ledger_checkpoint_balances` in chronological order, including
current and future-dated months; the checkpoint therefore means “through the
latest verified folded month,” not “closed months only.” Normal mutations apply JSON-bound old/new payer,
split, and settlement contributions to monthly totals and checkpoint rows in
the same D1 batch. Ready reads combine checkpoint and post-checkpoint periods
and never read legacy `group_balance_projection`; pending, dirty, missing, and
 failed state uses direct authoritative aggregation. The legacy aggregate 0003
 triggers are removed, while old Workers remain safe because legacy dirty
 triggers update only the new monthly maintenance state; new-worker mutations
 leave the legacy `projection_state.status` and ready projection untouched.

Migration 0024 uses a staged monthly rollout. It does not rebuild the whole
database or repurpose legacy projection tables, but it does replace the legacy
0003 aggregate triggers with hybrid guards. Existing groups remain pending
until bounded maintenance verifies each month; ready reads combine the rolling
checkpoint with the bounded post-checkpoint tail. A single maintenance pass
folds at most one verified month and yields when another foldable month
remains, so publication occurs only after the checkpoint reaches the latest
verified month. Creating a new month while ready queues maintenance; its
bounded incremental tail remains readable until maintenance claims the group,
after which pending fallback is used.

Apply migrations before each Worker deploy, then deploy the summary-aware Worker. Normal expense, settlement, restore, delete, and generated-occurrence batches update authoritative detail plus affected monthly/checkpoint rows atomically; date moves decrement the old month and increment the new month. Pending, dirty, missing, and failed state falls back to direct authoritative aggregation. Monthly Cron maintenance is bounded and fair, reports structured counts without financial content, and has no 750-group threshold or full-group rebuild.

For the practical per-group target, run the optional local large-ledger check
(default and maximum 10,000 entries); it uses a disposable local D1 harness and
never uses `--remote`:

```sh
npm run validate:large-ledger -- --entries 10000
```

The validator seeds a projection exactly equal to the authoritative expenses,
payers, splits, and settlements, performs one post-seed mutation, verifies the
full exact projection against a fresh authoritative aggregation and the O(1)
gross total, then checks the mixed transaction page and `EXPLAIN QUERY PLAN`.
The unified query may materialize and sort its two group-scoped streams; this is
intentional and is covered by the benchmark.

### Scheduled-template lifecycle

When a schedule creator leaves, is removed from a group, or deletes the
account, active templates created by that user are atomically terminal-cancelled
(`status='cancelled'`, `next_occurrence_date=NULL`, and no generation claim).
Existing generated expenses remain ordinary ledger history. Cleanup is scoped
to the creator, so removing a participant does not cancel another active user's
template merely because that person appears in its payer/split list. Manual
cancellation uses the same terminal cursor state. Ownership transfer does not
cancel templates: the outgoing owner may continue owning them after becoming a
member.

Scheduled templates fetch one bounded page initially and expose explicit
**Load more scheduled expenses**. This prevents unbounded client requests and
memory growth while making a partial list explicit rather than silently
presenting it as complete.
