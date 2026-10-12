# Reliable update core: integration contract

## Integration and ownership

The update core supplies discovery, local reload barriers, waiting-worker
coordination, and live Settings/Header controls. Preparation and reload are
fail-closed until the application explicitly enables `safetyIntegrated`.
Main registration starts discovery independently; the mounted `App` enables
safety after its children publish layout-effect blockers:

```ts
configureServiceWorkerUpdates({ safetyIntegrated: true, autoApply: true });
```

This works before async registration completes. An integration that already owns
the registration can instead call:

```ts
observeServiceWorkerRegistration(registration, {
  safetyIntegrated: true,
  autoApply: true,
});
```

Repeated observation changes options without duplicating listeners. Disable
`safetyIntegrated` when the application owner unmounts; this cancels preparation.
`disposeServiceWorkerUpdates()` cancels attempts, releases gates, and removes
listeners/timers. Configuration persists across disposal/reinitialization.

Draft owners use `useReloadBlocker(condition, reason)` from
`reload-safety-react.ts`, with an explicit dirty flag or semantic saved-baseline
comparison. Untouched defaults do not block. Blur, failed saves, or closing a
disclosure must not erase dirty ownership. If state survives closing, keep its
blocker mounted. Dialogs that can lose meaningful work block for their open
lifetime. `createReloadBlocker(reason)` covers non-React ownership and returns
an idempotent release function.

Protect complete operations using dependency-light `reload-safety.ts`:

- `runProtectedOperation(() => fullPromise, reason?)` releases in `finally`.
- `beginProtectedOperation(reason?)` protects synchronously and returns an
  idempotent release; use `try/finally` for confirmations/external lifetimes.
- `assertReloadOperationAllowed()` rejects new starts during preparation with
  `UpdatePreparingError` (`code: UPDATE_PREPARING`).
- `subscribeReloadSafety`, `getReloadSafetyState`, and `useReloadSafety` expose
  ownership, gate presence, revision, and last interaction.

Start protection before API dispatch or IndexedDB/outbox work. Cover enqueue,
claim, reconcile, retry/discard, logout/deletion, local clear, export/file pickers,
and provider authentication. A timeout does not finish the underlying write:
protect that write's full lifetime, not just its timeout wrapper. An idle stored
outbox entry is not an active operation. Applying an update never clears
IndexedDB or discards queued operations. Update gates are separate from logout
and must not reuse an uncancelled exclusive-mutation timeout.

## Readiness and consumer state

`observeReloadInteractions(document)` captures pointer, keyboard, input, change,
submit, and focus events before React. They synchronously invalidate preparation
and restart the **two-second** idle period; this supplements semantic blockers.

`checkForUpdates()` manually bypasses passive throttling but never applies or
reloads. `checkForUpdates(false)` coalesces/throttles passive checks. Startup,
visible focus/pageshow/visibility resume, reconnect, and a 30-minute visible
interval trigger discovery independently of API authentication. Failures back
off; a check deadline is not successful installation.

`getServiceWorkerUpdateState` / `subscribeServiceWorkerUpdate` expose:

- `phase`: initializing, unsupported, idle, checking, installing, no-update,
  ready, blocked, applying, check-error, install-error, offline, or deferred;
- `blockerReason`, `error`, `lastCheck`, `lastSuccess`, and compatible
  `updateReady`, `applying`, `blocked` booleans;
- independent `offline` discovery state;
- optional immutable `pageBuild` and actual controller/waiting-worker identity
  diagnostics (`activeBuild`, `waitingBuild`). Missing replies mean unavailable
  or unverified, not current and not consent.

`applyServiceWorkerUpdate(true)` (default) starts a manual attempt. It waives
**only the initiating tab's idle requirement**, using a captured safety revision
through REQUEST, PREPARE, VALIDATE, ACTIVATING, and verified reload. Interaction
or semantic safety changes invalidate that waiver. Drafts, operations, identity,
and other tabs' automatic inactivity requirements remain mandatory; there is no
sticky force flag. `applyServiceWorkerUpdate(false)` is automatic.
`cancelServiceWorkerUpdate()` retires the local attempt and releases its gate.

Settings Device follows Profile and provides checking, Update now, error retry,
and the last successful check. The compact Header offers Update now without a
persistent automatic waiting announcement. Manual failures provide actionable
save/other-tab help separately from automatic blocker state. Discovery needs
connectivity; an installed, identity-verified waiting update may apply offline.
No update action discards work or clears local storage.

## Waiting-worker authority

The actual waiting worker coordinates `BILLSPLIT_UPDATE_V1`. It enumerates all
same-origin scoped windows, including uncontrolled clients. Each must prepare
after two seconds of local inactivity (except the initiating manual waiver),
hold a leased gate, and acknowledge final validation. Membership is checked
between rounds and before `skipWaiting`. Dirty, busy, legacy, missing, or silent
clients block modern activation. Clean idle hidden clients acknowledge but
defer their own refresh until visible.

Source/attempt IDs, targets, and ACK rounds must match. Cancellation, timeout,
or coordinator loss releases gates. `acquireReloadGate`, `ownsReloadGate`, and
`releaseReloadGate` use bounded leases and token-matched ownership; a stale
release cannot cancel a newer attempt. New protected operations reject while
a valid prepare gate is held.

`controllerchange` verifies the actual controller identity, ignores first
installation, and reloads at most once only while local safety still holds.
Otherwise refresh remains protected and deferred. ACTIVATING is uncommitted
intent, not a reloadable deferred target; matching RELEASE clears it. Losing
simultaneous requests release independently of another attempt's gate, and a
participating tab does not initiate another request.

Automatic wakeup uses one idle-deadline timer. Coalesced blocker notifications
wake promptly without recursive requests from gate publication. Remote failure
cooldowns are bounded/jittered and not bypassed by gate release. Visibility
resume does not fabricate interaction. Lost identity replies retry with
exponential backoff (3–60 seconds); a manual check can restart verification.
Unknown identity is never an applicable target.

The narrow compatibility exception accepts bare `{ type: 'SKIP_WAITING' }`
only from a validated sole scoped window, confirmed by two membership checks
and serialized against modern attempts. Rejections are not deferred. A valid
competing modern request receives its matching RELEASE; invalid messages and
duplicate legacy requests do not veto/disturb the check. This exception relies
on the old page's local guards, not modern persistent drafts or cross-tab consent.

Browser APIs cannot make enumeration/activation atomic with opening a window,
or prevent interaction after a remote ACK. Late/unprepared or newly dirty tabs
must still pass local safety before reload; conservative asset retention is the
fallback. Cancellation cannot reverse `skipWaiting` once invoked.

## Coherent artifacts and cache retention

The finalizer hashes worker policy and emits per-file SHA-256/byte lengths for
HTML, manifest/icons, and generated JS/CSS/fonts/lazy assets. It injects immutable
`billsplit-build` into generated `index.html`, fingerprints those final bytes,
and emits the identical `/__billsplit_shell__.bin`. Deploy finalized HTML,
canonical binary, and `sw.js` together; never mix generations.

The Worker retrieves the binary through ASSETS with a fresh GET and serves
octet-stream with `no-cache, no-transform`. Missing assets, SPA HTML fallbacks,
redirects, and partial responses fail closed. The SW checks network provenance,
security/CSP headers, exact length/hash, and the complete dependency manifest
before constructing cached HTML. Ordinary `/` HTML may be edge-transformed but
is never a production installation fallback. Matching filenames are insufficient.
Reads/hash completion are bounded. Failed installation removes only its newly
created partial cache after underlying opens/writes settle, never a pre-existing
active generation.

Active workers reclaim only `bill-split-shell-*`. A bounded nonce/source-bound
scan asks windows for their loaded HTML generation, not their newer controller.
Reports authorize retention only, never readiness. Records use a reserved Cache
entry, not IndexedDB. Retention keeps:

- current and reported live page generations;
- frozen first-observation candidate sets for unknown/legacy clients;
- recently closed generations/candidates for a 24-hour handoff grace;
- one previous completed and one oldest metadata-less generation;
- newer waiting/incomplete installations within their conservative 24-hour grace.

Unknown sets persist across restarts/generations without accumulating every
future deployment. After client closure/grace they can be reclaimed. Membership
is checked around record persistence; uncertain membership, metadata, or browser
capability postpones unsafe pruning. No fixed numeric cap evicts live-page assets.

## Recovery

For incompatible multi-window clients: save drafts, finish writes, close **all**
BillSplit tabs and standalone windows, then reopen. Refreshing individual tabs
is not recovery. Never clear site data or the outbox to apply an update.

Public GET/HEAD `/api/app-update-recovery` runs before API authentication and
serves static no-store HTML with restrictive CSP, no scripts, and no interpolated
request/query data. Other methods/sibling paths remain ordinary authenticated
API routes. API-excluding old workers let this reach network instructions without
booting the App or opening/upgrading IndexedDB. Offline navigation fails honestly.
The endpoint activates nothing, unregisters nothing, clears nothing, and forces
no reload. Silent/unsupported clients do not consent to modern preparation.

Settings opens recovery with `noopener noreferrer` in a separate tab, retaining
the original unsaved profile. Close that recovery tab too: it is another scoped
window and can delay natural waiting-worker activation.

## Verification and release checks

Current worktree results and prior-only coverage are consolidated in the
[matrix verification record](responsive-audit-matrix.md#verification-and-release-checks).
That record distinguishes executed checks from remaining release checks.

Lifecycle fixtures use real same-origin A/B finalized artifacts and core modules,
not an authenticated full-App A/B migration. The pinned cache-first worker controls
a static script-free shell and proves recovery network bypass/offline rejection
only; it does not prove historical App database migration or pending-write replay.
Existing explicit legacy cases use a synthetic adapter and fixture-owned queued
row. Fixtures need no history/network retrieval. Presentation fixtures do not
prove activation. See [responsive audit matrix](responsive-audit-matrix.md) for
width scopes, commands, screenshots, and pending manual checks.

Before release compare deployed binary SHA-256/length with finalized local HTML
and SW fingerprint; check 200, MIME, cache/CSP headers, no redirect, full GET body
even with Range/conditional headers, and bodyless HEAD. Exercise explicit legacy
activation in one window and rejection with another open; verify cached `/` and
`/index.html` preserve bytes/HTML MIME. Chromium evidence is not real iOS Safari,
native-picker, other-engine, or authenticated full-App migration verification.
