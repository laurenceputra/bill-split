# Real service-worker lifecycle fixture

Run in CI (with the matching Playwright Chromium installed):

```sh
npx playwright test --config tests/e2e/fixtures/update-playwright.config.ts
```

Run in the runtime container using the existing `/ms-playwright` browser cache:

```sh
node scripts/test-update-lifecycle-local.mjs
```

These standalone commands run `service-worker-update.spec.ts` without Wrangler,
D1, or a base URL. The actual Worker/ASSETS endpoint integration lives separately
in `service-worker-endpoint.spec.ts` and requires the main e2e configuration:

```sh
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e:local -- tests/e2e/service-worker-endpoint.spec.ts tests/e2e/service-worker-update.spec.ts --project=chromium
```

The spec owns an isolated random-port HTTP server. Vite bundles the **production
update core and reload-safety modules** into two distinct A/B entry bundles.
Each build copies production `public/` files and runs the production service
worker finalizer against its complete output before serving it. The browser
registers that actual finalized worker; no Playwright request routing, worker
mock, synthetic controller change, or clock acceleration is involved.

This is not the full authenticated App. The semantic draft blocker and durable
IndexedDB outbox row belong to this fixture, using production protection APIs.
Full App profile/dialog ownership remains covered by application tests.

Coverage includes first installation, manual no-update and server-error checks,
two-client automatic activation after the real five-second idle interval,
persistent dirty ownership after blur, a held full-promise operation, durable
idle queued data, unrelated cache retention, and failed/mismatched finalized
entry installation followed by offline navigation to the old shell. It also
covers transformed ordinary HTML with unchanged canonical bytes and cached
security headers, plus historical-page/old-worker migration and close-all/reopen
recovery without clearing the outbox. Contexts
are fresh per test; builds are shared within a worker. Failures retain standard
Playwright screenshots and traces.
