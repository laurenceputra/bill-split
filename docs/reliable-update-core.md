# Reliable update core: integration contract

## Historical upgrade transport and activation

Finalized installs fetch `/__billsplit_shell__.bin`, an octet-stream asset containing
the exact identified `index.html` bytes. The Worker retrieves the actual binary
through ASSETS with a fresh GET and serves `no-cache, no-transform`; missing assets,
SPA HTML fallbacks, redirects and partial responses fail closed. The SW validates
network provenance before constructing the HTML response, retains security/CSP
headers, and verifies exact SHA-256/length and the complete dependency manifest.
Transformed ordinary `/` HTML is never a production install fallback.

Historical pages may explicitly send the bare `{ type: 'SKIP_WAITING' }` message.
Only a verified sole scoped window (including uncontrolled windows), confirmed
by two membership enumerations, may activate this way. Checks are bounded and
serialized against modern attempts; rejected requests are not deferred. This
arbitration begins only after source scope and message identity validation. A
validated modern request arriving during a legacy check receives its matching
`RELEASE`; invalid competing messages cannot veto a legacy request. Duplicate
legacy requests do not disturb the in-progress check.
Legacy activation relies on the historical page's explicit local form/mutation guard, **not** modern
persistent dirty-draft or cross-tab protection. Enumeration and activation cannot
atomically prevent a newly opened window race.

For multi-window legacy recovery, save drafts and finish writes, close **all**
BillSplit tabs and standalone windows, then reopen. Never clear the outbox or
site data to apply an update.

Deployment smoke check: compare the deployed binary's SHA-256 and byte length to
the final local `dist/index.html` and generated SW fingerprint; confirm HTTP 200,
octet-stream, `no-cache, no-transform`, CSP and no redirect. Check GET with Range
and conditional headers still yields the full body, and HEAD is bodyless. Ordinary
HTML may include edge scripts, but canonical bytes must not. Exercise an old
controlled page's explicit update in one window and rejection with another window
open; verify cached `/` and `/index.html` retain original bytes and HTML MIME.

The integrated flow supplies discovery, local reload barriers, waiting-worker
coordination, persistent draft/dialog ownership, full API/IndexedDB/outbox and
authentication operation protection, and live Settings/Header update controls.
The mounted `App` owner enables safe automatic application after its children
publish their blockers; unmount disables integration and cancels preparation.

## Enablement is fail-closed

`observeServiceWorkerRegistration(registration)` starts discovery, but refuses
preparation and reloads until `safetyIntegrated: true` is explicitly supplied.
For an integration with mounted draft/dialog and full-operation protections, call:

```ts
observeServiceWorkerRegistration(registration, {
  safetyIntegrated: true,
  autoApply: true,
});
```

Calling it again for the same registration changes options without duplicating
listeners. `disposeServiceWorkerUpdates()` cancels the attempt, releases its gate,
and removes lifecycle listeners and timers. Do not enable protection before the
application state owners mount. Main registration starts discovery independently;
the mounted `App` owner enables preparation and automatic application through
`configureServiceWorkerUpdates` after the UI's layout-effect blockers are published.

Alternatively, the mounted application state owner can call
`configureServiceWorkerUpdates({ safetyIntegrated: true, autoApply: true })`.
This also works **before** async registration completes, so the state owner
does not need to obtain the registration handle. Disable `safetyIntegrated` in
that owner's cleanup; disabling cancels any prepared/requested attempt.
Configuration persists across observation disposal/reinitialization, while
the disposal itself removes all gates, timers, and listeners.

## Draft and dialog ownership

Import `useReloadBlocker(condition, reason)` from `reload-safety-react.ts`.
Use an explicit dirty flag or a semantic comparison with the saved baseline.
Blur, failed saves, and closing a disclosure must not reset dirty ownership.
If state survives closing, keep the hook mounted at that state owner. Untouched
defaults should not block. Dialogs that can lose meaningful work also use the
hook for their entire open lifetime. Layout effects publish blocker changes.

For non-React lifetimes, `createReloadBlocker(reason)` synchronously adds a
blocker and returns an idempotent release function.

`observeReloadInteractions(document)` is installed by the page update core.
Capture-phase pointer, keyboard, input, change, submit, and focus events
synchronously invalidate any prepared gate and restart the five-second idle
period **before** React handles the event. This supplements semantic blockers;
it is not a replacement for persistent dirty-state integration.

## Operations and mutation starts

Import these from dependency-light `reload-safety.ts`:

- `runProtectedOperation(() => fullPromise, reason?)` protects the complete
  underlying operation and releases in `finally`, including rejection.
- `beginProtectedOperation(reason?)` protects synchronously and returns an
  idempotent release function. Use `try/finally` for native confirmations or
  other synchronous/external lifetimes.
- `assertReloadOperationAllowed()` rejects new starts while a prepare gate is
  held, with `UpdatePreparingError` (`code: UPDATE_PREPARING`).
- `subscribeReloadSafety`, `getReloadSafetyState`, and `useReloadSafety` expose
  draft/operation ownership, gate presence, revision, and last interaction.

Start protection **before** API dispatch or IndexedDB/outbox work. Protect
enqueue, claim, reconcile, retry/discard, logout/account deletion, local clear,
export, and provider authentication lifecycles. Never protect only a timeout
wrapper: its deadline does not finish an underlying write. A stored idle queued
outbox entry is not an active operation and is not itself a blocker.
The application now protects these UI and central data-operation lifetimes,
including underlying durable writes that continue after a caller's timeout.
Applying an update does not clear IndexedDB or discard queued operations.

The update barrier is separate from logout. `acquireReloadGate(token, leaseMs)`,
`ownsReloadGate(token)`, and `releaseReloadGate(token)` are used by the update
core. Gates have bounded leases; token-matched release cannot cancel a newer
attempt. New protected operations reject while a valid gate is held. Do not
reuse the existing uncancelled exclusive-mutation timeout for activation.

## Discovery and consumer state

`checkForUpdates()` is the manual check: it bypasses passive discovery throttle
but never applies/reloads. `checkForUpdates(false)` is coalesced and throttled.
Startup, visible focus/pageshow/visibility resume, browser reconnect, and a
30-minute visible interval trigger passive checks independently of API auth.
Failures back off; a check deadline cannot be mistaken for installation.

`getServiceWorkerUpdateState` / `subscribeServiceWorkerUpdate` expose:

- `phase`: initializing, unsupported, idle, checking, installing, no-update,
  ready, blocked, applying, check-error, install-error, offline, or deferred;
- `blockerReason`, `error`, `lastCheck`, and `lastSuccess`;
- `offline` independently disables discovery without disabling installed application;
- compatible `updateReady`, `applying`, and `blocked` booleans.

`applyServiceWorkerUpdate(true)` (the default) starts a manual attempt. It waives
only the initiating tab's inactivity requirement, using the captured safety
revision through REQUEST, PREPARE, VALIDATE, ACTIVATING and verified reload.
Subsequent interaction or semantic safety changes invalidate the waiver; it is
never a sticky force flag. Drafts, operations, identity and other tabs' automatic
inactivity requirements remain mandatory. `applyServiceWorkerUpdate(false)` is
automatic. `cancelServiceWorkerUpdate()` retires the local
attempt and releases its barrier. Settings Device, after Profile, provides live
manual checking, Update now, error retry, and the last successful check.
The compact Header silently offers Update now when available; automatic blockers
do not announce persistent waiting messages. Manual failures expose actionable
draft/save/other-tab help separately from automatic blocker state.
Installed, identity-verified waiting updates may apply offline; discovery still
requires connectivity. No update action discards work or clears local storage.

## Waiting-worker authority

Modern coordination accepts `BILLSPLIT_UPDATE_V1` messages. The actual waiting worker
enumerates all same-origin window clients in its registration scope, including
uncontrolled clients. Each must acknowledge preparation after five seconds of
local inactivity, hold a leased gate, and acknowledge a final validation round.
Membership is checked between rounds and again before `skipWaiting`. A dirty,
busy, legacy, missing, or unresponsive client blocks activation. Clean idle hidden
clients acknowledge both rounds but defer their own refresh until visible. Source IDs,
attempt IDs, targets, and ACK rounds are matched. Cancellation, timeout, or
coordinator disappearance releases all participating gates. The narrowly scoped
historical exception accepts only bare `{ type: 'SKIP_WAITING' }` from a verified
sole scoped window, confirmed by two membership checks and serialized against
modern attempts. It relies on the historical page's local guards, not modern
cross-tab preparation or persistent dirty-draft protection.

`controllerchange` queries the actual controller identity, ignores first
installation, and reloads at most once, only if local safety still holds.
Otherwise it keeps a protected deferred refresh and retries without spinning.
`ACTIVATING` is only uncommitted intent: it never creates a reloadable deferred
target. A matching `RELEASE` clears that intent. Losing simultaneous requests
are released independently of a different attempt's held gate. A participating
tab does not start another request, and retry timing includes jitter.
One idle-deadline timer wakes automatic application at last interaction plus five
seconds. Coalesced safety notifications wake promptly when local blockers clear;
gate publications cannot recursively start requests. Remote failure cooldowns
remain bounded and jittered, and gate release does not bypass those cooldowns.
Visibility resume does not itself fabricate interaction or delay a safe refresh.
Lost waiting/controller identity replies are retried with exponential backoff
(3 seconds up to 60 seconds); a manual check can restart identity verification.
Unknown identity remains a verifying/blocked state, never an applicable target.

## Coherent build artifacts and cache retention

The finalizer now emits per-file SHA-256 fingerprints and exact byte lengths
for HTML, all manifest/icons, and all generated JS/CSS/font/lazy assets. Worker
policy is also included in the generation hash. It injects an immutable
`billsplit-build` meta tag into **the generated index.html**, then fingerprints
those final HTML bytes and emits an identical canonical binary shell. Fixtures
and deployments must publish matching finalized **index.html, canonical binary,
and sw.js** artifacts together, not pre-finalization HTML or mixed generations.
The binary transport must preserve the exact finalized bytes: hashing rejects
any injection or minification of that transport. Ordinary HTML responses may be
transformed by edge scripts; production installation never uses them as a fallback.
Installation verifies fetched bytes using WebCrypto with bounded body reads
and hash completion. Matching entry filenames alone are insufficient. A failed
install removes its newly created partial cache after outstanding underlying
cache writes/opens settle; it never deletes a pre-existing active generation.

Active workers reclaim only their own `bill-split-shell-*` namespace. A bounded
client-build scan asks scoped windows for the immutable loaded-HTML generation,
not their possibly newer controller generation. Reports are nonce/source-bound
and used **only for retention**, never as proof of clean/idle readiness.
Generation/client records live in a reserved Cache entry, not IndexedDB.

Retention keeps:

- the current generation and every reported live page generation;
- a first-observation, frozen candidate set for each unconfirmed/legacy client;
- recently closed client generations/candidates for a 24-hour handoff grace;
- one previous completed generation and one oldest metadata-less generation;
- newer waiting installations and incomplete installations within their
  24-hour conservative grace.

Frozen unknown sets persist across worker restarts and generations. A legacy
tab may require several existing caches, which cannot safely be reduced to one
without knowing its HTML build, but it does **not** accumulate every future
deployment. After that tab closes and the grace expires, those candidates are
reclaimed. Confirmed clients permit unused older generations to be reclaimed.
Pruning checks membership before and after persisting records; if membership,
metadata reads, or browser capabilities cannot be established, it postpones
unsafe reclamation. There is no blanket deletion or fixed numeric cap that
would evict assets still needed by a live page. Storage is proportional to live
generations, frozen unknown candidates, and the bounded-time handoff grace.

**Limitations:** browser APIs cannot make `matchAll` and `skipWaiting` atomic
with a new window opening. Likewise, a user's interaction can arrive after the
last remote ACK. Late/unprepared or newly dirty tabs must never blindly reload;
the local safety check and conservative prior-build asset retention are the
fallback. Cancellation is not reversible after `skipWaiting` is invoked. This
is not a claim of absolute distributed atomicity. Real A/B lifecycle and
responsive browser validation have been executed within the scopes below, not
as an authenticated full-application A/B migration audit. During the one-time
rollout from the legacy worker/page protocol, legacy open tabs cannot acknowledge
modern preparation and therefore block coordinated activation. The sole verified
legacy-window exception described above permits an explicit historical request.
For multi-window legacy recovery, save drafts and finish writes, close **all**
BillSplit tabs and standalone windows, then reopen; refreshing individual tabs
is not the recovery procedure. Never clear site data or the outbox.

## Executed verification and scope

Current PR verification passed **929 unit tests, 27 integration tests, and 1
migration test**, plus typecheck and production build.

- **9 standalone Chromium lifecycle tests** use a real same-origin server switching coherent
  production worker/shell artifacts and the actual core modules. This verifies
  service-worker A/B lifecycle behavior in a dedicated production-core fixture,
  **not an authenticated full-App A/B deployment**. These run without Wrangler;
  the main e2e configuration also passed the same nine tests plus **1 Chromium
  Worker/ASSETS endpoint integration test**.
- **Previous-work evidence, not rerun in this PR:** **11 Chromium
  update-settings/avatar/user-feedback tests** include the live
  Settings order and blurred drafts, plus shared production-component status
  presentation at 320, 390, 767, 768, 895, 896, and 1440px. The status fixtures
  cover 98 phase/reason/width configurations; injected presentation states do not
  themselves prove worker lifecycle behavior.
- **Previous-work evidence, not rerun in this PR:** **7 Chromium date-control
  tests** passed as focused responsive regressions.

Local browser runs used the existing executable resolver and `/ms-playwright`
cache. WebKit was unavailable locally; its browser verification remains pending
CI. Chromium evidence does not claim real iOS Safari/native-picker coverage.
