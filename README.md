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

Production defaults to `ENVIRONMENT=production` and has no development bypass. For local Worker development use the named Wrangler environment (`npx wrangler dev --env dev`) or explicitly provide `ENVIRONMENT=development`; only that exact value enables the local `X-Dev-Email` helper. The browser adds this helper only in a Vite development build. The `env.dev` D1 binding in `wrangler.toml` uses a clearly non-production placeholder UUID: local Wrangler creates isolated D1 state under the E2E `--persist-to` directory, while an accidental deploy of the dev environment cannot bind the production database. Keep `env.dev` local-only and do not replace that placeholder with a real resource ID. Production uses same-origin Clerk session cookies; BillSplit does not persist a bearer token.

## Cloudflare setup and deployment

1. Use the provisioned D1 database configured in `wrangler.toml` and apply its migrations:

   ```sh
   npx wrangler d1 create bill-split
   # copy its database_id into wrangler.toml
   npm run db:migrate:remote
   ```

2. Configure Clerk for the production origin `https://billsplit.laurenceputra.com`. Enable email verification-code sign-in and public signup; do not enable social sign-in for this application. Configure the custom session claim `{"primaryEmail":"{{user.primary_email_address}}"}`. Set these Worker configuration names outside this repository: `CLERK_PUBLISHABLE_KEY`, encrypted `CLERK_SECRET_KEY`, `CLERK_JWT_KEY`, `CLERK_AUTHORIZED_PARTIES` (a comma-delimited allowlist containing the exact app origin), and the required encrypted `IDENTITY_TOMBSTONE_KEY`. `IDENTITY_TOMBSTONE_KEY` is a stable production secret used only for keyed HMAC-SHA-256 deletion tombstones; do not use a rotating Clerk secret. `CLERK_SECRET_KEY` is required by the installed Clerk backend client even when `CLERK_JWT_KEY` enables networkless token verification. Set `VITE_CLERK_PUBLISHABLE_KEY` in the Vite production build environment. The Worker derives the Clerk FAPI CSP source from `CLERK_PUBLISHABLE_KEY` using Clerk's supported publishable-key parser; no extra FAPI binding is required. Missing or malformed keys fail closed for external CSP sources while same-origin assets remain available. The Worker verifies session tokens locally with the Clerk JWT key and rejects tokens from unauthorized parties. Never place keys, credentials, tokens, or additional domains in this repository.

3. Deploy:

    Apply and verify all D1 migrations, including the latest `0021_deleted_identity_tombstones.sql`, **before** deploying this Worker. The deploy command does not apply migrations automatically; do not skip this ordering because the Worker references the Clerk identity, account-deletion, identity-tombstone, audit snapshot, private category preference, and collaboration lifecycle schema. Before deployment, set the required secret with `npx wrangler secret put IDENTITY_TOMBSTONE_KEY`; this repository intentionally does not contain its value.

   ```sh
    npm run deploy
    # equivalent explicit production/default environment:
    npx wrangler deploy --env=""
    # inspect the bundle and bindings without uploading:
    npm run deploy:dry-run
   ```

   Deploy only after remote migrations are applied and verified. The Worker
   expects the complete schema, including projection and audit actor-snapshot
   migrations; deployment does not apply D1 migrations.

Wrangler serves `dist` through the Workers Static Assets binding and routes `/api/*` to Hono. API errors are returned by Hono and are not hidden by SPA fallback. Do not put secrets in `wrangler.toml`; use `wrangler secret put` or the dashboard. Add this optional binding when receipts are enabled:

```toml
[[r2_buckets]]
```

The schema already includes attachment metadata. Receipt upload/download is deliberately not part of the core UI; an implementation should generate short-lived authorized object URLs only after checking group membership.

Keep production Clerk values in Wrangler encrypted secrets or dashboard encrypted settings; in particular, set `CLERK_SECRET_KEY` with `wrangler secret put CLERK_SECRET_KEY`, and set `IDENTITY_TOMBSTONE_KEY` separately. Keep local values in the ignored `.dev.vars` file. OAuth credentials must live outside this repository. The account and D1 IDs in `wrangler.toml` are non-secret resource identifiers, not credentials.

## Data and API

All SQL files in `migrations/` are applied in order; `0003_ledger_total_limits.sql` installs authoritative D1 triggers that conservatively cap active gross expense-plus-settlement totals at `Number.MAX_SAFE_INTEGER` per group and currency, including concurrent inserts and relevant restores/updates. `0013_projection_layer.sql` adds compact gross totals and per-person net projections in a pending state; existing groups are never published as ready by migration. The projection-aware Worker dual-writes while the legacy aggregate remains authoritative, and bounded Cron backfill publishes readiness only after an atomic recomputation. `0014_projection_indexes.sql` adds stable keyset and person-leading indexes, `0015_audit_actor_snapshot.sql` adds non-email actor snapshots, `0016_projection_readiness_reset.sql` safely repairs installations that applied the earlier ready-state projection migration before deploying the Worker, and `0017_cleanup_indexes.sql` removes only exact duplicate indexes. `0018_category_preferences.sql` adds private, per-user learned categories keyed by `trim(description)` followed by lowercase; explicitly chosen categories remain preferences even when their originating schedule is cancelled. `0019_group_membership_events.sql` records owner transfers, self-leaves, and owner removals with actor/name snapshots (never email) and enforces one active owner per group. `0020_account_deletion.sql` adds the user soft-delete marker needed to retain financial/audit foreign-key anchors while pseudonymizing personal identity. `0021_deleted_identity_tombstones.sql` stores keyed HMAC-SHA-256 email/Clerk identity tombstones so a deleted account cannot be silently relinked after live identity fields are cleared. Seed data, when used locally, must remain local.

Important endpoints include:

- `GET /api/me`, `GET/POST /api/groups`, group updates/deletion, owner-only member administration/removal, owner transfer (`POST /api/groups/:id/transfer-ownership`), member self-leave (`POST /api/groups/:id/leave`), historical settlement participants (`GET /api/groups/:id/historical-participants`), and in-app email-targeted invitations (`/api/groups/:id/invitations`, `/api/invitations`)
- `DELETE /api/account` with the exact JSON confirmation `{"confirmation":"DELETE MY ACCOUNT"}`. Deletion is blocked with a structured conflict containing only the active owned-group count. Eligible deletion soft-leaves non-owned memberships, revokes pending invitations, pseudonymizes every invitation history row addressed to the deleted email, removes private category/idempotency data, clears the Clerk linkage, and pseudonymizes the user/person while retaining financial rows and audit actor-name snapshots for referential integrity.
- `GET/POST /api/groups/:id/expenses`, `GET/PUT/DELETE /api/expenses/:id`
- `GET/POST /api/groups/:id/settlements`, `GET/PUT/DELETE /api/settlements/:id`, and versioned restore endpoints
- `GET/POST /api/groups/:id/scheduled-expenses`, `GET/PUT /api/scheduled-expenses/:id`, and pause/resume/cancel actions
- balances (raw and deterministic simplified debts), activity, versioned JSON export, group JSON/expense CSV/settlement CSV export

Expense and settlement writes validate membership, supported two-decimal ISO currency, real calendar dates, safe integer values, participant uniqueness, and exact payer/split totals before using D1 `batch()` for atomic related writes. Active-user and active-participant predicates are repeated inside mutation batches, so a removal racing a write cannot grant access or introduce a removed participant. Removed participants remain valid settlement endpoints for clearing outstanding balances, while new expenses and schedules require active participants. D1 ledger-limit triggers are authoritative for races and return structured `BALANCE_OVERFLOW`/422 errors; checked application arithmetic remains in place for legacy or imported data. Supported currencies are USD, EUR, GBP, AUD, CAD, NZD, SGD, HKD, CHF, CNY, and INR; currencies with a different minor-unit exponent (for example JPY) are intentionally rejected. `client_operation_id` claims are scoped by mutation kind and authenticated user/group and include a request hash. Updates and deletes require the loaded integer `version`, use conditional writes, snapshot the previous state in `revisions`, and append actor user/person IDs plus a name snapshot (never email) with before/after records to `audit_events` in the same batch. Group ownership transfer and member self-leave are serialized D1 operations with repeated authorization predicates, soft-removal, pending-invitation revocation, and append-only non-email snapshots in `group_membership_events`; only a current owner can transfer to an active linked member, and owners must transfer or delete before leaving. Legacy audit rows fall back to `Unknown user` when no current person is available. Audit history is available at `GET /api/groups/:id/audit` with bounded pagination. Deleted transaction detail and restore are available for 30 days.
Conditional mutations guard the parent and child statements in one D1 batch and then verify the resulting version. This avoids silent stale overwrites even where a D1 batch does not expose a convenient affected-row count; a failed post-batch version check returns `CONFLICT`.

Historical settlement participants are authorized separately from active membership. Removed people and deleted accounts remain available for outstanding settlement endpoints with `Removed` or `Deleted account` labels, while new expenses and schedules continue to accept active members only.

The expense, settlement, scheduled-expense, and audit lists support bounded opaque keyset pagination. Expense and settlement pages are ordered by `(expense_date|settlement_date, created_at, id)`, scheduled templates by `(created_at, id)`, and audit pages by `(occurred_at, id)`, all descending with the ID tie-breaker. Responses expose `nextCursor`; an `offset` on expense, settlement, or audit endpoints returns structured `400 INVALID_PAGINATION` rather than being ignored. Offset pagination remains explicitly supported only on scheduled-expense list requests for one deployed-client grace release so old cached PWA clients do not repeat page one. The current client always uses the cursor. Expense search accepts description/notes, member, category, date range, and currency filters and rejects a complete UTF-8 LIKE pattern over 50 bytes (including wildcards). JSON responses use `{ error: { code, message } }` for structured failures.

Scheduled expenses are recurring templates, not ledger rows. From a group or friend ledger, choose **Add expense**, leave it one-time, or turn on **Repeat this expense** to configure a custom daily, weekly, monthly, or yearly interval. Weekly schedules require one or more weekdays; an optional end date is inclusive. The creator timezone defaults from the browser and can be edited as an IANA timezone. The form previews up to three localized next dates and explains whether the schedule continues until paused/cancelled or through its end date. A Worker cron generates ordinary expenses only when their occurrence is due, so occurrences affect balances only when posted; future templates do not affect balances. Generated expenses remain in the ledger even if the template is later edited, paused, or cancelled. Edits are online-only and apply only to future occurrences. Schedules show their status, next occurrence, and any blocked reason, and can be paused, resumed, or cancelled online. Schedule mutations never enter the expense outbox. Cron catch-up is bounded to 20 occurrences per invocation and 20 occurrences per template, processed round-robin so a stale template cannot starve other schedules. When a cursor reaches a cap it remains due and is continued by later invocations; dates are not silently skipped, and operators should edit, pause, or cancel a template if historical catch-up is not wanted. The same scheduled handler performs bounded 30-day purging, generation, and projection backfill and logs structured outcomes. Generated occurrence tombstones remain after a generated expense purge, preventing Cron from regenerating that occurrence; transaction idempotency tombstones are retained where needed for safe retries.
The former `/groups/:id/scheduled-expense/new` URL redirects to the combined expense form; existing schedule edit URLs remain available for recurring schedule management.

## Client features and limitations

The app includes groups, owner/member access, multi-payer expense editing, equal/exact/percentage-basis-point/share allocation, expense and settlement history/deletion/restoration, multi-currency balances, partial settlements, activity, and exports. Group owners can rename a group, change its default currency without conversion, or soft-delete it after a typed-name confirmation; these settings are online-only. Owners can transfer ownership only to an active linked member; non-owners can leave after confirmation, while owners must transfer first or delete the group. Group expenses can be filtered by search, member, category, date range, and currency. Filters use namespaced URL parameters, preserve unrelated route parameters, and reset cursor pagination when applied. Percentages are entered as basis points totaling 10,000 to avoid persisted floating point. Verified users see matched pending invitations in the app and can accept or reject them; owners invite by email, see expiry/status, revoke, retry, transfer ownership, and remove members with confirmation. There is no email copy or invitation-link UI. Removed people are excluded from new expenses and schedules but remain usable in settlement flows and are marked where historical data lacks an active member.

Expense, settlement, scheduled-expense, activity, and audit lists use opaque keyset cursors with Load more or bounded cursor-following. The first IndexedDB page remains an offline presentation and never implies that the ledger is complete; server-side expense filtering is disabled offline because filtered pages are not cached. New settlements default to today but allow a selected date, which is preserved while suggestions refresh and when resetting the suggested participants/amount. Detail pages include safe actor/timestamp audit differences, settlement details, and 30-day tombstones with version-checked restore; purged records return a normal not-found error. Group JSON, separate expense CSV, separate settlement CSV, and account-wide JSON exports are assembled page-by-page with progress, cancellation, download errors, File System Access where available, and a Blob fallback. CSV formula protection remains server-side.

`public/manifest.webmanifest`, the SVG icon, and `public/sw.js` provide the installable PWA shell. The service worker uses a versioned, bounded allowlist for static shell assets, serves navigation with a cached `index.html` fallback (including deep expense routes), and never caches `/api`, authentication paths, or mutation responses.

The app supports trusted-device offline capture for **new expenses only**. After a successful online visit, the unlocked browser profile stores one atomic, 30-day offline-trust record containing the verified internal identity and current Clerk user ID, plus user-scoped group/member snapshots and recent group data. Legacy split identity records never establish offline trust; explicit Clerk sign-out or account changes durably revoke the record. A new expense is written to a durable, leased IndexedDB outbox before any network attempt, then replayed with the same payload and `client_operation_id` once connectivity and a Clerk session are available. Pending rows show Waiting to sync, Syncing, Sign in to sync, or Sync failed and can be retried or discarded (with confirmation); hung writes time out and remain retryable. If verification is unavailable, the shell shows bounded retry guidance rather than claiming the user is signed out. During phone sleep/wake, matching cached private data remains on the current route while Clerk restores or the foreground session check runs; server mutations and outbox replay wait for authoritative verification. No reload is attempted while offline, and queued expenses remain in IndexedDB and resume after a successful Clerk sign-in. Offline edits, deletes, settlements, membership changes, exports, and other reads without a matching cached snapshot remain unavailable. Local cache access is not server authorization: replay still requires the normal Clerk session, and no local token bypasses it.

Settings can clear cached identity, groups, snapshots, and recent preferences without deleting pending or delivery-uncertain outbox operations. Those operations must be resolved through their queue controls. Logging out first quiesces mutations and clears local private data, then asks Clerk to end the session and redirect to `/`; it warns when expenses are unsynced and does not expose or commit any token. State-changing API requests and destructive logout use the Web Locks API when available, so supported Chromium browsers and installed PWAs wait for every dispatched mutation to settle before local data is cleared. Browsers without Web Locks still block new mutations through the same-tab registry plus the storage/BroadcastChannel session barrier, but cannot observe a fetch still in flight in another tab; users should finish logout in a Web Locks-capable browser when that cross-tab guarantee matters.
Account deletion is separate from Clerk account management: the server deletion succeeds first and writes an identity-bound, non-sensitive pending-deletion marker outside IndexedDB. The app processes that marker before private hydration; a `server-pending` marker retries the authenticated, idempotent server DELETE with the marker's exact Clerk ID in `X-BillSplit-Expected-Clerk-User-Id`, and never clears local data or calls Clerk until the server commit is confirmed. The Worker requires both an authenticated Clerk identity and that exact request binding before repository deletion. It then clears all local BillSplit data and calls the installed Clerk client's typed `UserResource.delete()` API. If the session expires or the user signs out after server/local cleanup, the marker remains and the app requires sign-in to the same Clerk account before provider deletion; only a confirmed `provider-deleted` marker may be cleared while signed out. Actor-name snapshots in financial audit and membership history are intentionally retained without email/contact details.

Remaining intentional MVP limitations are no offline editing/deletion/settlement/membership sync, no offline schedule management, no currency conversion, and no receipt upload UI. Scheduled templates are fetched online and are not cached for offline use. IndexedDB can be cleared by the browser or unavailable in private/restricted contexts; those conditions are surfaced rather than silently dropping queued expenses. The `attachments` table and optional `RECEIPTS` R2 binding remain an extension point; any future routes must check group membership before issuing object access. D1 migrations must be applied explicitly in each environment, and production Clerk configuration remains an operator responsibility.

### Rate limiting

The Worker uses Wrangler 4.86's native `[[ratelimits]]` binding; it does not use
D1 or a third-party limiter. Cloudflare native limits are enforced per location
and are eventually consistent, so they provide best-effort abuse mitigation,
not a hard global invariant. The default production binding is `RATE_LIMITER`
with account-scoped namespace `510001`, and the explicitly repeated `env.dev`
binding uses namespace `510002` because rate-limit bindings are not inherited by
named Wrangler environments. Each authenticated internal user ID gets a
separate operation bucket, limited to five calls per minute at each location, for group creation,
friend creation, invitation creation, and invitation accept/reject. The Worker
returns structured `429 RATE_LIMITED` JSON with `Retry-After: 60` when a limit
is exceeded.

Protected production routes fail closed with `503 RATE_LIMITER_UNAVAILABLE` if
the binding is missing or unavailable. Development and test environments may
use the deterministic binding or the explicit exact-value development/test
bypass; this bypass is never enabled for production. Expense, scheduled
expense, and settlement writes—including offline idempotent expense replay—are
intentionally not rate limited.

### Operations

Apply migrations before each Worker deploy, then deploy the projection-aware
Worker before depending on projected balances. Existing groups begin with
`projection_state.status='pending'`; the scheduled Worker backfills at most two
groups per tick and marks each ready only after its bounded recomputation
commits atomically. The legacy aggregate remains the safe fallback while a
group is pending or backfilling. The same 15-minute Cron performs bounded generation and purges
deleted transaction and group data older than 30 days. Cron emits compact JSON
outcomes for generated/blocked/capped work, projection readiness/failures, and
purged counts. Worker observability is enabled in `wrangler.toml` with low trace
sampling; application logs contain request metadata and operational counts only,
not secrets, emails, or transaction content.

For an optional local large-ledger check (default 10,000, maximum 100,000
entries), use the disposable local D1 harness; it never uses `--remote`:

```sh
npm run validate:large-ledger -- --entries 100000
```

The validator seeds equal-date/equal-created-at expenses and settlements,
checks the mixed transaction page and `EXPLAIN QUERY PLAN`, and reports the
bounded page elapsed time. The unified query may materialize and sort its two
group-scoped streams; this is intentional and is covered by the benchmark.

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
