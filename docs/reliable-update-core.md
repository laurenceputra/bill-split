# Reliable update core: integration contract

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
- compatible `updateReady`, `applying`, and `blocked` booleans.

`applyServiceWorkerUpdate()` remains a compatibility adapter. It never bypasses
idle/draft/operation gates. `cancelServiceWorkerUpdate()` retires the local
attempt and releases its barrier. Settings Device, after Profile, provides live
manual checking, error retry, contextual status, and the last successful check.
The compact Header uses the same state. Neither offers a force-refresh/discard
action, and checking while dirty never bypasses reload protection.

## Waiting-worker authority

Only `BILLSPLIT_UPDATE_V1` messages are accepted. The actual waiting worker
enumerates all same-origin window clients in its registration scope, including
uncontrolled clients. Each must acknowledge preparation after five seconds of
local inactivity, hold a leased gate, and acknowledge a final validation round.
Membership is checked between rounds and again before `skipWaiting`. A dirty,
hidden, legacy, missing, or unresponsive client blocks activation. Source IDs,
attempt IDs, targets, and ACK rounds are matched. Cancellation, timeout, or
coordinator disappearance releases all participating gates. Bare legacy
`SKIP_WAITING` no longer bypasses this protocol.

`controllerchange` queries the actual controller identity, ignores first
installation, and reloads at most once, only if local safety still holds.
Otherwise it keeps a protected deferred refresh and retries without spinning.
`ACTIVATING` is only uncommitted intent: it never creates a reloadable deferred
target. A matching `RELEASE` clears that intent. Losing simultaneous requests
are released independently of a different attempt's held gate. A participating
tab does not start another request, and retry timing includes jitter.
Lost waiting/controller identity replies are retried with exponential backoff
(3 seconds up to 60 seconds); a manual check can restart identity verification.
Unknown identity remains a verifying/blocked state, never an applicable target.

## Coherent build artifacts and cache retention

The finalizer now emits per-file SHA-256 fingerprints and exact byte lengths
for HTML, all manifest/icons, and all generated JS/CSS/font/lazy assets. Worker
policy is also included in the generation hash. It injects an immutable
`billsplit-build` meta tag into **the generated index.html**, then fingerprints
those final HTML bytes. Fixtures and deployments must serve the finalizer's
worker **and its final index.html** together, not the pre-finalization HTML.
Byte hashing intentionally rejects HTML rewritten after finalization, including
edge-injected or minified HTML; deployments must preserve the finalized bytes.
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
preparation and therefore block coordinated activation until users safely close
or refresh them. There is no legacy-message activation bypass.

## Executed verification and scope

Current verification passed **898 unit tests, 26 integration tests, and 1
migration test**, plus typecheck and production build.

- **6 Chromium lifecycle tests** use a real same-origin server switching coherent
  production worker/shell artifacts and the actual core modules. This verifies
  service-worker A/B lifecycle behavior in a dedicated production-core fixture,
  **not an authenticated full-App A/B deployment**.
- **11 Chromium update-settings/avatar/user-feedback tests** include the live
  Settings order and blurred drafts, plus shared production-component status
  presentation at 320, 390, 767, 768, 895, 896, and 1440px. The status fixtures
  cover 98 phase/reason/width configurations; injected presentation states do not
  themselves prove worker lifecycle behavior.
- **7 Chromium date-control tests** passed as focused responsive regressions.

Local browser runs used the existing executable resolver and `/ms-playwright`
cache. WebKit was unavailable locally; its browser verification remains pending
CI. Chromium evidence does not claim real iOS Safari/native-picker coverage.
