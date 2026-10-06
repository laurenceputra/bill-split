# Reliable update UI integration

`App` is the stable safety owner. After its children mount and publish layout-effect
draft blockers, it enables `safetyIntegrated` and `autoApply`; unmount disables
integration and cancels preparation. Registration alone still cannot opt in.

## Persistent work

Owners protect group/friend creation, group settings and conversions, targeted
and generic invitations, add-friend disclosures, split defaults, expenses and
recurrence fields, settlement creation/editing, History filter drafts, Insights
custom dates, profile name/avatar, deletion confirmation, and refund applications
and allocations. Closing persistent editors, blur, and failed validation/save do
not discard their ownership. Expense and settlement creation use their existing
conservative dirty flags; resetting a suggested amount does not clear other edits.

Saved group/profile/email baselines are refreshed without overwriting dirty work.
Successful conversions and split-default clear reset their saved baseline. Refund
comparison excludes generated row IDs and provenance metadata, captures initialized
values before user changes, and does not block untouched async initialization.

Modal lifetime, install help/native installation, native confirmations/prompts,
observable Clerk modal DOM, auth transitions, and account-deletion recovery also
block preparation. Clerk modal detection supplements the core capture-phase
interaction and DOM protections; it is not a replacement for draft ownership.

## Full operation lifetime

UI operation protection starts before dispatch/confirmation and spans follow-up
invalidations and navigation. This includes creation, membership/invitations,
conversion, split-default save/clear, queued expense retry/discard, schedule status,
expense/refund/settlement submit/delete/restore, exports through native file writing,
local clearing, logout through Clerk, deletion, and recovery cleanup. Central API,
outbox and IndexedDB protections additionally cover underlying durable lifetimes.
Read-only pagination and category suggestions do not create mutation ownership.

## Update controls

Settings order remains Profile, Device updates/install, then administrative and
destructive sections. Device exposes manual checking even with dirty drafts,
state-specific help, retry, and last successful check. Header uses the same
contextual state. Neither has a bypass, force refresh, nor discard-and-apply action.

## Validation

Mounted tests cover profile async initialization, failed saving, semantic reversion,
hidden add-friend/targeted-email/split-default drafts, and refund edit initialization,
failed validation and note reversion. Markup tests cover checking/installing,
unsupported/offline, errors and dirty-blocked discovery.

`tests/e2e/update-settings.spec.ts` executed successfully with the local browser
resolver at 320, 390, 767, 768, 895, 896 and 1440px. Its two tests cover Settings
order, absent activation bypass, drafts through blur, and production-component
presentation for all 13 update phases plus separate local/other-tab blockers:
**98 phase/reason/width configurations**. Status fixtures inject markup rendered
by the same pure `UpdateStatus` component used by the live UI into the real app's
Settings/header slots; they validate geometry and enabled states, **not worker
lifecycle or discovery/activation behavior**.

The combined local run of update-settings, avatar, and user-feedback passed
**11 browser tests**. It exposed and fixed profile field refresh isolation:
an untouched name follows a remote rename while a dirty avatar is preserved.
The earlier missing-default-browser failure was resolved through the existing
local executable resolver, without installing browsers. The separate lifecycle
run passed 6 Chromium tests with actual core modules and coherent production
worker/shell artifacts on a real same-origin A/B server. That is a dedicated
production-core fixture, not an authenticated full-App A/B audit. The focused
date-control run also passed 7 Chromium tests. WebKit was unavailable locally;
its verification remains pending CI.

Insights only owns unapplied dates while the custom editor is active. Choosing
a preset discards that editor; returning to custom initializes blank dates.
A mounted regression covers applied-custom → preset and genuine unapplied edits.
