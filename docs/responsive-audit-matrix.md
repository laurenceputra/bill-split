# Warm Ledger responsive audit matrix

## Home sorting

Focused coverage: `tests/e2e/home-insights-surfaces.spec.ts`, at **320, 390,
768, 895, 896, 1440px**. Primary Add friend / New group actions precede the
labelled native Sort control, which precedes the combined friend/group cards.

| State | Checks at all six widths |
| --- | --- |
| Name (A–Z), default | Compact labelled control, numeric case-insensitive display-name order, existing balance/card geometry and navigation boundary; no contextual help |
| Outstanding first | Reordered cards, visible default/fallback and no-conversion help, no horizontal overflow |
| Reload / cached refresh failure | Per-account local preference retained; cached cards remain sortable after failed group refresh |
| Offline, already loaded | Both modes usable without a network request; name mode hides help |
| Cold loading | Existing skeleton, no sort control before cards exist |
| Empty / uncached error | Existing empty/error notices, no irrelevant sort control |

Pure helper and hook tests cover all summaries (not display-truncated), default
currency zero fallback, absent/empty/zero summaries, absolute positive/negative
minor amounts across currencies without FX, unknown before settled, name/ID
ties, immutability, invalid/unavailable/throwing storage and account switches.

Reference captures: `docs/screenshots/home-{mobile,desktop}.png`,
`home-sgd-stress-{mobile,desktop}.png`, and `home-outstanding-{mobile,desktop}.png`.
Captures await fonts and disable animations; mobile bottom navigation is hidden
only for full-page capture after live layout/navigation checks. Regenerate with:

```sh
UPDATE_HOME_SCREENSHOTS=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright BILLSPLIT_E2E_PORT=8798 BILLSPLIT_E2E_PERSIST_DIR=/tmp/bill-split-playwright-home-sorting npm run test:e2e:local -- tests/e2e/home-insights-surfaces.spec.ts --project=chromium --workers=1
```

Verification: `npm run test:unit -- --maxWorkers=2` passed (65 files, 946 tests);
`npm run build` passed with the existing large-chunk warning. An independent
focused Chromium rerun passed all eight tests despite a runtime broken-pipe
warning. Reviewer approved with no findings. Mobile outstanding and desktop name
captures were visually inspected. Full integration and full responsive audits
were not run.

## Refund recipient defaults and allocation editing

### Receipt, benefit and settlement clarity follow-up

Final reviewer regressions: linked edits continuously validate inactive derived
shares against saved exact amounts even after a supported original-split reset.
An unsupported change blocks submission with actionable help and Money flow
section focus; restoring applied amounts or reopening the preserved custom
snapshot recovers without silent overwrites. Saved edit recipients remain manual
until Use full total explicitly resumes amount following (person defaults remain
new-only). Removing every manual beneficiary shows a stable aggregate error and
focuses Money flow on submit, with Add affected member / original split recovery.
The empty-section browser state covers all nine audit widths, no credit mutation,
focus, overflow and recovery. Curated screenshots additionally include
`refund-improvements-empty-beneficiaries-{mobile,desktop}.png`.

Audit widths: **320, 390, 480/481, 767/768, 895/896, 1440px**. The focused
refund browser suite covers blank validation/focus, editable default hint,
beneficiary disclosure/reset, multiple recipients and very-long decimal values
at every width. All refund decimal inputs share the expense amount shell with
an unfocused border, 0.00 placeholder, focus/error treatment and length classes.
Standalone currency is editable inside the total control; linked/allocation
currencies are static. Person → amount → remove DOM order stacks below 896px;
desktop has two spacious columns with remove on its own row, not a reserved
third column. Inspect help/action spacing and unfocused allocation borders.

Settlement wording appears only for complete valid drafts. Insurer-to-wife
coverage checks positive original-payer and negative recipient deltas, zero
effects, invalid-preview suppression, and separate-payment help hidden for
standalone/provider modes. No total balance or pairwise transfer is inferred.
Existing loading/cached/offline/empty/error and historical edit/reset checks
remain applicable; the follow-up does not change their accounting or guards.

Curated artifacts: `docs/screenshots/refund-improvements-{default,validation,
insurer-wife,allocations}-{mobile,desktop}.png`. Generate with
`REFUND_SCREENSHOTS=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e:local -- tests/e2e/linked-refund.spec.ts`.
These capture actual UI at 390/1440px with unfocused controls, using isolated
seed data and read-only response overrides for the named wife/medical-bill
scenario; no financial mutations or production data are captured.

Follow-up verification: 57 targeted refund/credit/form-helper unit tests passed,
including retained historical reset guards. Typecheck and production build
passed (existing large-chunk warning). Focused Chromium tests passed; the
geometry assertions also require each visible decimal input to retain >100px
of width and its composite shell to keep a 1px unfocused border. Screenshots
were visually inspected on desktop and mobile after correcting shared-grid
and preview-flex sizing conflicts. Full matrix/integration suites were not run
for this follow-up; this is not a claim of full-suite coverage.

Reviewer follow-up: Supported Use original expense split resets return to read-only,
server-derived benefits (no explicit historical beneficiary overrides); reopening
retains custom snapshots. New manual adjustment is unavailable with contextual
help when an original split includes ineligible former members, whose historical
names remain visible. Application aggregate errors are separate from total-money
validity, and blank expense/invalid applied amounts receive save-attempt focus.
Add recipient requires the existing blank row to be completed and respects the
eligible-member row limit. At all six widths the focused browser scenario checks
overflow and scroll reachability of Save at blank/positive-total validation,
invalid applied amount, beneficiary disclosure, original-split reset and added
recipient states.

Edit reset eligibility mirrors `creditParticipantGuard` in
`src/db/repository.ts:1709–1726` and its update use at 2031: every inactive derived
beneficiary must match a saved allocation's exact person, beneficiary type and
minor-unit amount. Unlike create (2012), update does not exempt newly derived
historical allocations. Unsupported edit resets are disabled with contextual
help and guarded in the handler; active shares and unchanged saved historical
shares allow reset. This condition is verified through focused UI/helper tests,
not a new repository integration test. No repository/config changes were made.
Blur validation is control-local; unrelated note/source blur does not expose
untouched required errors. Submit attempts still reveal all errors and focus the
first invalid control. Full-total reset resumes automatic following on the next
total change. Browser scenarios cover unrelated blur and automatic following at
all six widths; historical edit eligibility is covered in mounted/helper tests.

At **320, 390, 768, 895, 896, 1440px**, audit new member reimbursement with
the editable current-member default and hint (sole active member fallback;
otherwise blank), blank-submit field errors and first-invalid focus, corrected
fields, automatic full amount after recipient/total changes, manual override,
explicit full/remaining reset, multiple recipients and remaining/overallocated
status. Added rows remain blank and Add recipient disables when choices run out.
Audit Adjust who benefits populated from the current split and Use original
expense split reset, plus saved custom/historical edit allocations unchanged.
Primary save remains reachable for invalid drafts; offline/loading/busy save
remains unavailable. Cached expense refresh must update capacity/shares; empty
choices retain actionable local errors without fabricated participants. Check
labels/errors/actions wrap without horizontal overflow at all widths. Focused
`linked-refund.spec.ts` scenarios cover blank errors/focus, amount following,
beneficiary disclosure/reset and added-recipient geometry; fallback, cached,
offline and historical edit variants require additional manual verification.

Focused Chromium verification passed both linked-refund scenarios and the
existing online/offline submission audit (three tests), including all six
widths, using the repository's local cached-browser wrapper. Typecheck
and 35 targeted refund/helper unit tests passed, including sole/no-current
fallback, supported/unsupported historical edit reset payloads, repeated blank Add and same-count expense
capacity refresh regressions. The full unit-suite attempt
exceeded a 120-second execution limit; it is not reported as passing.

## Compact Add transaction chooser

| View/state | 320 / 390px | 768px | 895 / 896px | 1440px |
| --- | --- | --- | --- | --- |
| Global `/add`, multiple groups, no selection | One labeled native Group / person dropdown with Choose a group; one disabled action set, expense first; full labels stack with 44px targets | Wrapping action row | Same across navigation boundary | One compact action set, no repeated group headings |
| Global selected / switched, long names | Alphabetical display names; all three destinations follow selection without overflow | Same, row wraps as needed | Same | Same |
| Global exactly one group | Automatically selected, immediate actions | Same | Same | Same |
| Scoped chooser / unavailable group | Group heading and immediate actions, no dropdown; unavailable group has no action set | Same | Same | Same |
| Loaded to offline / cached refresh error | Expense stays available for selected group; refund/payment disabled; offline and cached notices shown once | Same | Same | Same |
| Loading / empty / cold error / removed selection | Loading has no invented choices; empty retains create-group/add-friend links; cold error retains retry; removed selection clears and disables actions, never redirects to another group | Same | Same | Same |

Additional chooser layout boundary: **599px stacks actions; 600px uses a wrapping
row**. At both widths, check unselected, selected and offline labels for complete
containment, non-overlap and minimum 44px dropdown/action targets. The same checks
apply at 320, 390, 768, 895, 896 and 1440px.

Recorded Chromium outcomes (2026-10-07): **7 focused tests passed**, comprising
the six `transaction-chooser.spec.ts` tests plus the existing scoped offline audit.
Unselected, selected long-name and offline geometry passed at all eight widths,
including 599/600. At 320px, deterministic gated requests verified selected-group
removal leaves the placeholder/all actions disabled even with one remaining group;
cached API refresh failure retains selection and all destinations with one notice;
global delayed loading, empty, cold error/retry; scoped delayed lookup without a
false unavailable alert and retained actions during refresh; single-group and
completed-unavailable scoped states. Refresh tests use the existing successful-auth
resource-refresh event, without expiring identity or relying on sleeps. Cached
failure uses HTTP 400 so connection rules remain online; server/network failures
can additionally disable online-only actions under the existing connection rules.
Cold offline reload and other-browser chooser coverage were not added.

The separate existing split-transaction navigation accessibility test failed on
rerun at its offline-disabled assertion (line 876). The identical failure was
reproduced against an untouched `git archive HEAD` baseline (6039f3a), not merely
inferred from the chooser diff. Its SW/auth/navigation root cause remains outside
this chooser change; no navigation code or assertions were changed.

## Compact person totals and secondary split control follow-up

| View/state | 320 / 390px | 639px (below person breakpoint) | 640 / 768px | 895 / 896px | 1440px |
| --- | --- | --- | --- | --- | --- |
| Spending by person / loaded, positive ties | Identity groups name and winner badge; share and paid retain visible labels and right-aligned amounts | Labeled stacked metrics | Person / Allocated share / Paid headings align with three compact columns; numbers right-aligned | Same columns across shell breakpoint | Person block capped at 48rem without narrowing summary or charts |
| Spending by person / long names, large amounts | Names and amounts wrap without clipping or overflow | Stress wrapping contained | Three columns wrap within their cells | Same containment | Reading-width block stays contained |
| Group overview / chevron closed, hovered, focused, open | Shared purple secondary background and border match default link at rest/hover; shared 3px focus ring; joined 44px geometry | No overview change at person breakpoint | Same treatment and native in-flow panel | Same treatment across shell breakpoint | Stable header positions; panel spans joined control |

`insight-people.spec.ts` covers person layout at 320, 390, 639, 640, 768, 895, 896, 1440px and computed secondary rest/hover colors, borders and focus alongside existing six-width overview geometry. Period/currency, zero/no winner, old-response compatibility, empty, failed-refresh and same-session offline/cache cases remain covered. Seeded all-time USD, font-ready reference captures support `GROUP_SCREENSHOTS_SKIP_HISTORY=1` to refresh only the eight affected overview/insights images without history churn.

## Group history, person insights, and top actions

Focused browser coverage in `tests/e2e/insight-people.spec.ts` verifies the Spending insights direct destination and native More group actions select closed/hover/focus, keyboard picker opening/cancel, primary-before-admin order, matching 44px control/chevron geometry, and stable title/action/card positions at all six audit widths. History and settings navigate and reset the placeholder on return, including cached offline navigation; these destinations remain enabled, unlike server-only transaction actions. At 320px it verifies distinct exact share/paid amounts, USD/EUR selection, positive ties, all-zero/no winner, custom-period selection, empty suppression, compatibility with responses missing people, and cached totals retained after a failed refresh and while offline. A long unbroken historical name and large amounts are checked for both page overflow and person-row clipping. Cached persistence here is same-session resource-cache persistence, not a cold offline reload test.

At **320, 390, 768, 895, 896, 1440px**, audit **More group actions closed, hovered, keyboard-focused, and native picker open/cancelled**: Add expense and Settle up precede the Spending insights direct link and separate 44px admin select; the picker contains a placeholder, Group history, and Group settings only. Both halves retain secondary colors and separate focus targets without horizontal overflow. The picker is browser/OS chrome, not an inline panel: opening must not move cards or title/actions. Automated coverage exercises Alt+ArrowDown/Escape and validates DOM options and navigation; manually verify touch picker presentation and keyboard selection on target browsers, since native popup chrome is not captured by DOM screenshots. Cold loading/error/unavailable overview states retain their existing placeholder/error views without invented actions; cached/refresh-error/empty/offline overviews retain the same navigation destinations.

At the same widths, audit group Changes, Transactions, and Insights: the authorized selected group's Back to group link precedes filters, updates on selection, and disappears for All groups or unavailable groups. Cached authorized group data retains this context. Person insights show allocated share and paid independently for the selected summary period/currency, including tied highest payers and no highest payer for all-zero data. Names and amounts wrap at narrow widths.

State checks for these views: loading shows no invented person totals; cached/offline summaries retain person totals and notices; empty periods show no person list; cold errors show retry rather than totals; stale errors retain cached totals with notices. Overview loading/unavailable states do not expose management actions without group data. Older cached summaries without person details omit the list until refreshed. These are audit requirements, not claims of completed browser coverage; focused seeded checks cover context and person lists at 320/1440 and global insights at all six widths.

Canonical audit widths are **320, 390, 768, 895, 896, and 1440px**. The
private shell keeps the mobile bottom navigation through 895px and switches to
the desktop top navigation and two-column group overview at 896px.

| Home / Insights state | 320px | 390px | 768px | 895px | 896px | 1440px |
| --- | --- | --- | --- | --- | --- | --- |
| Populated Home groups | Single compact, content-height white linked cards; wrapped names and ISO-coded numeric balances remain readable with no painted inner rows | Same; primary group links precede management | One readable column | One column and bottom navigation | Up to two columns and desktop navigation | Two readable columns; no stretched card heights |
| Home loading, cached, offline, empty, error | Skeleton/notice, cached/offline status, empty-state creation actions, and retry remain distinct; no inaccessible group links when data is absent | Same | Same | Same | Same | Same |
| Global and group Insights summary/chart | Route audit only | Focused summary/chart paint, transparent sections, tabs and chart accessibility | Route audit only | Route audit only | Route audit only | Focused summary/chart paint, transparent sections, tabs and chart accessibility |

`tests/e2e/home-insights-surfaces.spec.ts` checks populated Home card paint,
content-height geometry, destinations, currency labels, action order and navigation
at all six widths with two intercepted realistic groups (long name, large SGD
balance and EUR debt). Global and group Insights summary/chart paint, transparent
sections, accessible tabs and chart are checked at 390 and 1440px; other Insights
widths and Home loading/cached/offline/empty/error states remain in the existing
route audit and targeted fixtures, not this focused geometry spec.

Loaded local-browser references (all six Home images regenerated with anonymous,
fully synthetic demo groups, balances and spending summaries; identity is Demo user
and avatars use only demo initials, with no inherited names or avatar hashes):
`docs/screenshots/home-mobile.png` (390px, full page) and `home-desktop.png`
(1440px viewport) show Demo friend and Sample project; `home-sgd-stress-mobile.png` (390px,
full page) and `home-sgd-stress-desktop.png` (1440px viewport) show the
two-group synthetic API fixture (Demo friend, SGD 42.16; nine-person Shared project
with a long sample name for responsive testing, SGD 5,439.72 and EUR 123.45 owed).
`home-outstanding-mobile.png` and `home-outstanding-desktop.png` show the same
demo scenario sorted outstanding-first. The loaded
all-time USD references `spending-insights-global-mobile.png`,
`spending-insights-group-mobile.png` (390px full page),
`spending-insights-global-desktop.png`, and
`spending-insights-group-desktop.png` (1440px full page) show separate filled
summary and chart surfaces; `warm-ledger-insights-desktop.png` is the same
1440px group Insights view. The mobile bottom navigation was confirmed live
and hidden only for full-page capture to avoid a repeated fixed stripe. These
references do not depict loading, cached, offline, empty, or error states.

### Repeatable group references

`tests/e2e/group-reference-screenshots.spec.ts` uses the authenticated seeded
Europe trip group without API mocks. Regenerate only these group references:

```sh
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright UPDATE_GROUP_SCREENSHOTS=1 npm run test:e2e:local -- tests/e2e/group-reference-screenshots.spec.ts --project=chromium --workers=1
```

To refresh only the five overview references without history/insight churn, prefix the command with `GROUP_SCREENSHOTS_OVERVIEW_ONLY=1`.

Without the opt-in, captures are test attachments and do not overwrite tracked
images. Fonts are ready and screenshot animations disabled. Mobile uses 390×844
and desktop 1440×900 viewports; references are full-page except the explicitly
named viewport image. Fixed bottom navigation is verified live and hidden only
for full-page captures, not the viewport reference.

- Closed overview: [mobile](screenshots/warm-ledger-mobile.png),
  [desktop](screenshots/warm-ledger-desktop.png), and
  [mobile viewport with fixed navigation](screenshots/group-overview-mobile-viewport.png).
- More group actions beside Spending insights: reference screenshot generation now captures the focused native select (browser/OS picker chrome requires manual inspection); old expanded-panel screenshots are obsolete.
- Group Changes with Back to group: [mobile](screenshots/warm-ledger-history-mobile.png)
  and [desktop](screenshots/warm-ledger-history-desktop.png).
- Loaded group Insights (`period=all&currency=USD`) with real allocated share,
  paid totals, and highest payer: [mobile](screenshots/spending-insights-group-mobile.png),
  [desktop](screenshots/spending-insights-group-desktop.png), and the same
  [Warm Ledger desktop reference](screenshots/warm-ledger-insights-desktop.png).

The refund/reimbursement matrix below remains the release checklist for the
dedicated online-only refund flow. The Warm Ledger states cover the newer
credit and shell surfaces without replacing those refund-specific checks.

## Automated route coverage

### Account profile avatar

`tests/e2e/avatar.spec.ts` covers Settings choice/preview, persisted opt-in,
saved-name Home avatars, group People, desktop header, identity loading,
save errors, missing-image fallback, and cached offline editing restrictions at **320, 390, 767, 768, 895, 896,
1440px**. Gravatar requests are intercepted so this audit does not disclose
fixture identities to a third party. Profile save failure also has a separate
focused behavior case. Initial identity GET failure uses the existing auth
recovery shell rather than showing an editable unverified profile.
The avatar matrix also checks that a name-only cross-tab revision preserves an
unsaved avatar selection, and that named-group Home counterpart images use the
other user's preference rather than the current account's image.

| Profile / avatar state | 320 / 390 | 767 / 768 | 895 / 896 | 1440 |
| --- | --- | --- | --- | --- |
| Initials default and Gravatar choice/preview | Labeled native choice, privacy help wraps, preview uses account email, Save profile precedes admin | Same across form boundary | Same; saved avatar appears in desktop header from 896 | Same |
| Home and group People | Saved BillSplit name, not “You”, supplies initials; opted-in images use account metadata | Same | Same; header uses same preference | Same |
| Missing image / image failure | Initials, no broken image | Same | Same | Same |
| Cached / offline | Saved preference retained; initials rendered without image requests; saving disabled with contextual help | Same | Same | Same |
| Loading / empty legacy identity | Loading status; Save disabled until identity exists; legacy preference defaults to initials | Same | Same | Same |
| Identity or save error | Contextual error/retry; failed save preserves choice and permits retry | Same | Same | Same |

### Shared native date controls

`tests/e2e/date-controls.spec.ts` runs the same focused matrix in Chromium and
the `date-controls-webkit` project. Every row below checks initial, empty, and
populated date bounds against **every containing ancestor**, not just the page
(which can hide overflow), plus ISO value retention after editing and blur.
No overflow clipping or replacement picker is used. Specialized amount grids
retain their overrides of the shrinkable shared Field column.

| Date location/state | 320 | 390 | 767 / 768 | 895 / 896 | 1440 |
| --- | --- | --- | --- | --- | --- |
| Expense create/edit, Repeat off | Date contained | Same | Same across form boundary | Same across navigation boundary | Same |
| Repeat on, start/end; schedule edit | Both contained; optional end clears; end minimum follows start | Same | Same | Same | Same |
| Refund create/edit and credit edit alias | Date fits fieldset and form surface | Same | Same | Same | Same |
| Settlement create and edit open | Date fits shared field and form surface | Same | Same | Same | Same |
| Transaction filters expanded, global/group | From/to fit disclosure and filter grid | Same | Same | Same | Same |
| Custom insights, global/group | From/to fit insight grid; Apply range preserves values in URL | Same | Same | Same | Same |

For schedule starts only, empty native rendering is exercised without changing
the React draft: the existing schedule preview assumes a valid start. Other
empty controls use normal input events. The existing route/disclosure audits
continue to cover loading, cached, offline, empty-resource, and error states;
the focused matrix above is loaded-form geometry/value coverage, not a claim
that every resource state was rerun in WebKit. The audit geometry harness now
also reports date controls exceeding any ancestor whenever they are visible.

```sh
npm run test:e2e:local -- tests/e2e/date-controls.spec.ts --project=chromium
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e -- tests/e2e/date-controls.spec.ts --project=date-controls-webkit
```

The local browser resolver applies its discovered executable only to Chromium;
WebKit uses Playwright's matching installed browser. CI installs both browsers
and host dependencies and runs only this date suite in both projects. Linux
WebKit is not real iOS Safari: native picker presentation, localized date text,
and on-device touch/focus behavior still require real-device verification.

### Expense date and recurrence disclosure

The expense-only amount control shares Description's border, background, and
radius, without a section bottom rule. Currency occupies a fixed 104px left
segment with a vertical divider; the remaining amount is left aligned in normal
28px type (24px for long values). Very-long values stack inside the same shell,
with a horizontal divider and type at least 16px. Each child remains independently
keyboard accessible, with an explicit amount label and currency accessible name.
The shared focus-within outline follows either child; amount validation colors
the outer border and focus outline, including forced-color equivalents.
`expense-amount-layout.spec.ts` checks normal, long,
and very-long values at **320, 390, 767, 768, 895, 896, and 1440px**, including
44px touch targets, joined-shell geometry, keyboard focus, stacked fallback, no page overflow, and
returning to normal input. Boundary values of 9 and 15 characters retain the
existing normal/long thresholds. Oversized inline values can still scroll
internally in the native text input, especially at 320px; full simultaneous
visibility is not guaranteed. The focused Chromium test checks no internal
overflow for fitting text, complete value retention and Home/End caret access
for oversized text, and left-aligned text returning to its start on blur.
The date/recurrence audits below retain coverage of
disclosures and loading, cached/offline, empty, and error states.

The expense form uses native DOM order: Group/person (new entries), Amount,
Description, Date/Start date, Repeat (new entries), revealed recurrence settings,
payer and split, expense details, submit. The same date input stays mounted when
Repeat changes. Schedule edits omit Repeat and place settings after Start date.
Split/default/deletion behavior is unchanged.

| Expense state | 320 | 390 | 767 / 768 | 895 / 896 | 1440 |
| --- | --- | --- | --- | --- | --- |
| Repeat off; on monthly; on weekly with custom IANA timezone; off again | Date before payer/split; settings directly after checkbox; preview/help contained | Same | Same across form boundary | Same across navigation boundary | Same DOM order, readable width |
| Large group with long names and shares allocations, same four repeat states | Custom allocation stress; existing participant ellipsis reported separately | Same | Same | Same | Same |
| Loaded/cached group, offline recurring form | Group retained; schedule save disabled with online-only explanation | Same | Same | Same | Same |
| Loading group, unavailable group (503), empty global target | Distinct loading/retry/create-target states; no date or impossible save action | Same | Same | Same | Same |
| Expense edit / schedule edit | Existing route matrix | Focused behavior test: date precedes payer; settings follow Start date; no checkbox | Existing route matrix (768) | Existing route matrix | Existing route matrix |

`tests/e2e/audit.spec.ts` adds the focused `expense date recurrence` audits,
using the existing geometry/screenshot harness and rich, large, and empty fixtures.
All seven widths above are exercised for new-entry disclosure and unavailable
states. `scheduled-expense.spec.ts` checks direct adjacency/order, date-node
identity, amount/description/date/category/notes preservation, retained weekly
settings, edit modes and schedule-only submission.

Generate the four tracked full-page references directly from the loaded rich
fixture (USD 420, Shared apartment rent, October 15 2026, default monthly/UTC):

```sh
UPDATE_EXPENSE_SCREENSHOTS=1 npm run test:e2e:local -- tests/e2e/audit.spec.ts --grep 'expense date recurrence responsive audit'
```

The wrapper uses `/ms-playwright`; no browser installation is needed. Set
`BILLSPLIT_E2E_PORT` to a free port when another local harness is running.
The opt-in writes `docs/screenshots/expense-form-{mobile,desktop}.png` and
`expense-form-recurring-{mobile,desktop}.png` at 390/1440px. Fixed navigation
is checked live, then hidden only for tracked full-page capture to avoid covering
recurrence controls. Additional state screenshots and
`expense-date-findings.json` remain ignored under `test-results/audit/normal/`;
unavailable-state captures are under `test-results/audit/intercepted/`.
Existing long participant labels intentionally ellipsize: those containment
findings are recorded, not treated as date/recurrence regressions. Other major
geometry findings fail the focused audit.

`tests/e2e/audit.spec.ts` runs normal route scenarios at **320, 390, 768,
895, 896, and 1440px**. Redirects are recorded by their final canonical URL;
the routes below are the concrete fixture-backed paths, not placeholders.

| Surface | Exact route(s) | Normal state covered |
| --- | --- | --- |
| Public and private shells | `/`; `/` as `dev@example.com`; `/` as `empty@example.com` | Signed-out landing, populated groups, empty groups |
| Creation and add chooser | `/friends/new`; `/groups/new`; `/add`; `/groups/00000000-0000-4000-8000-000000003002/add` | Friend/group forms, global and group-scoped transaction choices; expanded people and offline group creation are focused states |
| Group and management | `/groups/00000000-0000-4000-8000-000000003002`; `/groups/00000000-0000-4000-8000-000000003002/manage` as `dev@example.com` and `registered@example.com` | Populated multi-currency overview, owner/member management, people email and generic invitation disclosures |
| Expense and schedule | `/groups/00000000-0000-4000-8000-000000003002/expense/new`; `/groups/00000000-0000-4000-8000-000000003002/expense/00000000-0000-4000-8000-000000004001`; `/groups/00000000-0000-4000-8000-000000003002/scheduled-expense/00000000-0000-4000-8000-000000007001` | New, edited, and recurring-edited forms; payer modal is captured at every canonical width |
| Refund/credit | `/groups/00000000-0000-4000-8000-000000003002/refund/new`; `/groups/00000000-0000-4000-8000-000000003002/refund/00000000-0000-4000-8000-000000008001/edit`; `/groups/00000000-0000-4000-8000-000000003002/credit/00000000-0000-4000-8000-000000008001/edit`; `/groups/00000000-0000-4000-8000-000000003002/credits/00000000-0000-4000-8000-000000008001`; `/groups/00000000-0000-4000-8000-000000003002/credits/00000000-0000-4000-8000-000000008002` | Record-money-back create, dedicated edit, credit edit alias, linked/standalone/direct-provider allocation states, active and deleted detail |
| Expense/settlement detail | `/groups/00000000-0000-4000-8000-000000003002/expenses/00000000-0000-4000-8000-000000004001`; `/groups/00000000-0000-4000-8000-000000003002/expenses/00000000-0000-4000-8000-000000004004`; `/groups/00000000-0000-4000-8000-000000003002/settle`; `/groups/00000000-0000-4000-8000-000000003002/settlements/00000000-0000-4000-8000-000000005001`; `/groups/00000000-0000-4000-8000-000000003002/settlements/00000000-0000-4000-8000-000000005002` | Active detail, edit/detail history, create form, and deleted/restore tombstones |
| History and settings | `/activity?group=00000000-0000-4000-8000-000000003002`; `/activity?group=00000000-0000-4000-8000-000000003002&view=transactions`; `/activity?view=transactions`; insight variants; `/settings` | Changes, transaction filters, insights (including custom/empty/error/loading/offline fixtures), profile/device/admin settings |

The focused behavior tests cover restore controls, an offline-disabled valid
refund submission, offline-disabled refund detail mutations, the typed
account-deletion gate and action ordering, the management invitation
disclosure, and transaction filter semantics at **390, 895, 896, and 1440px**.
Representative frequent/admin flow ordering, the loaded chooser's truthful
offline state, and client-side scroll/hash navigation run at **320, 895, 896,
and 1440px**. The development Clerk fixture intentionally has no destructive
account identity, so the account-deletion test does not submit that mutation.

## Refund/reimbursement states

Refunds are online-only ledger actions. Mobile DOM order keeps the common
expense-first path ahead of advanced standalone/custom allocation controls.

| Split Add control viewport | 320px narrow | 390px mobile | 430px mobile | 768px tablet | 895px tablet | 896px desktop | 1440px desktop |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Group header and contextual navigation | `Add expense` stays first; the transaction-type select is joined to it, and wrapped header actions do not overlap | The Add tile is contained; neighboring non-Add nav items are at least 44px wide and high | Compact labels remain on one row without clipping | Bottom navigation keeps the raised control ahead of Settings | Bottom navigation remains in use at the pre-desktop breakpoint | Desktop navigation switches on without changing destinations | Desktop control remains expense-first and alternatives open through the select control |
| Bottom-nav Add control shape and spacing | Plum Add tile fills a `clamp(100px, 25vw, 112px)` center column, extends about 8px above the bar, and reaches through the safe-area bottom via a decorative layer; every item uses the shared 20px icon canvas, 4px icon-label gap, and bottom content anchor, with the plus optically inset in that canvas and the Add label baseline matching neighboring labels; lower corners remain square, and the Add tile and primary segment are at least 44px high while the menu segment is at least 44px wide and high | Same raised tile geometry and shared two-row track; the safe-area extension does not stretch or shift the interactive controls, the 1px solid semi-transparent white shared divider remains visible in inactive and hover states and in both segment-specific keyboard-focus states, and inactive/active colors do not change dimensions | Raised tile remains centered and contained without clipping | Raised tile remains 112px wide and ahead of Settings | Raised tile remains 112px wide at the pre-desktop breakpoint | Desktop navigation switches on at 896px without changing destinations | The split choice may use a restrained segmented shape; the desktop control remains expense-first |

| View/state | 390px mobile | 768px boundary | 1440px desktop |
| --- | --- | --- | --- |
| Add transaction chooser, global/group, trusted-offline cache | Global Add still opens the chooser; cached groups or the cached group context expose Expense first and connection-required alternatives remain visibly unavailable; global/query-only History keeps Add global until group validity is known, and only the exact expense-new route is marked current | Buttons wrap without changing order | Primary choices remain above management links |
| Record money back, loading/cached/offline/error | Loading, stale-cache, offline, conflict, and server-capacity messages stay beside the form; submit is unavailable offline | Picker and amount context do not overflow | Expense-first form and submit remain before advanced controls |
| Source and handling controls | Linked member, standalone member, and linked direct-provider states keep “Apply this to”, “Source”, and “How was it handled?” associated with their help text; impossible standalone provider adjustment is unavailable | Mode changes preserve a valid standalone state and help remains readable | Source labels and accounting consequences remain visible without exposing implementation terms |
| Linked expense picker | Search/page controls and date/gross/refunded/remaining context remain readable; fully refunded rows are unavailable | Currency lock and additional-expense disclosure remain clear | Selected expense and currency context remain visible |
| Application status and actions | Rows have visible vertical separation; apply/load actions wrap as complete labels; signed remaining/overallocated status stays near the rows | 481–895px rows stack fields and removal controls without overlap | Capacity text remains distinct from the running refund status |
| Standalone/advanced allocations | Standalone member state exposes required recipient and affected-member controls in task language; no silent recipient default | Custom allocation rows wrap safely | Advanced controls remain secondary to the preview |
| Money-flow preview | Linked member and linked direct-provider states show each person once with received/payment-reduction/cost-reduction components and a signed net effect | Component lines and net effect keep their labels and amounts together | Grouped preview preserves stable person/component order |
| Expense detail | Gross, refunded, net, remaining, linked rows, and Add refund appear in reading order | Long notes and linked rows wrap | Add refund stays with the accounting summary |
| Refund detail active/deleted | Member names/You labels, linked expenses, money flow, balance effect, and collapsed audit remain reachable | Restore/conflict feedback is adjacent to the action | Audit is secondary to the plain-language accounting summary |
| History/filter states | Refund/reimbursement rows use the same filter and keyset list | Refund filter does not expose expense-only category controls | Rows preserve group and detail links |

This matrix is the release checklist. Current automated
coverage exercises routed loading state, form state
transitions, picker filtering, defaults, payload construction, Add-route cache
contracts, and focused split-control route/disabled-option behavior. The
Playwright audit scenario list represents the refund route across its mobile,
breakpoint-boundary, and desktop viewport set, including initial and populated
linked-member, standalone-member, and linked direct-provider states. The full
audit is the reference for complete route and viewport coverage.
Native `<select>` popup menus are browser/OS UI and are not reliably captured by
full-page screenshots, so their open-popup appearance still requires manual
visual inspection. The mobile Add tile uses a clipped, modestly rounded
interactive segment with an inset focus treatment; its separate pseudo-element
carries the plum treatment through `safe-area-inset-bottom` while the controls remain in
the regular navigation content height. Focused mobile E2E geometry covers 320,
390, 399, 400, 430, 447, 448, 480, 481, 600, 767, 768, and 895px in inactive and active states,
including the shared 20px icon centerline, 4px icon-label gap, common content anchor, and neighboring-label baseline, clamp transitions, neighboring non-Add item
width/height touch targets, Add segment minimum dimensions, contained labels,
overlap, document overflow, hover/active colors, focus visibility, and the
computed shared divider width, style, and color. The 895-to-896px desktop
navigation transition is asserted separately. The three 390x844 reference
captures are distinct group-overview, refund-form, and focused-helper states.

## Warm Ledger states

| View/state | 320px narrow | 390px mobile | 768px tablet | 895px boundary | 896px desktop | 1440px desktop |
| --- | --- | --- | --- | --- | --- | --- |
| Record money back / credit, loaded | Controls stack with the amount hero visible; no horizontal scroll | Form controls remain in DOM order: source, handling, amount, applications, allocations, note, submit | Verify select/field wrapping and no horizontal overflow | Verify disclosure and validation spacing at the breakpoint | Primary submit remains before secondary navigation | Primary submit remains before secondary navigation |
| Record credit, loading/error/offline | Loading status and inline error are announced; submit is disabled offline | Error text remains adjacent to the form | Error text remains adjacent to the form | Error text remains adjacent to the form | Error and retry remain content-sized | Error and retry remain content-sized |
| Credit detail, active | Applications and allocations stack; amount remains dominant | Application and allocation snapshots stack as rows; edit/delete follow detail | Verify rows wrap long IDs/notes | Verify deleted labels and restore affordance | Actions remain below the accounting explanation | Actions remain below the accounting explanation |
| Credit detail, deleted/restore | Restore is the only available mutation and is disabled offline | Tombstone copy remains visible | Tombstone copy remains visible | Restore remains a clear recovery action | Restore and error states remain readable without modal-only context | Restore and error states remain readable without modal-only context |
| Group home / invitations | Financial status leads each group card; invitation actions remain reachable; empty-state actions stack without overlap; spending snapshot stays borderless | Empty and populated states retain separate, touch-sized creation actions; group cards precede the divider-separated spending snapshot | Group cards use a denser two-column grid; snapshot currency rows remain aligned | Check group-card-to-snapshot boundary without a second painted snapshot surface | Group cards align amount columns and participant metadata; snapshot remains borderless | Group cards align amount columns and participant metadata; snapshot remains borderless |
| Home / compact insight, populated | Spending snapshot is a transparent, single-column ledger with divider rows | Same flattened metric reading order and no metric-card paint | Currency rows remain aligned without an enclosing card | Verify the compact snapshot remains flat at the breakpoint | Compact insight remains a secondary, borderless module after group cards | Compact insight remains a secondary, borderless module after group cards |
| Group overview | Add expense and Settle up precede the Spending insights default link and More group actions chevron; four macro-cards follow in DOM order: balances, transactions, schedules, people | Same order with 44px controls, flat internal rows, and native lists | Single-column financial reading order; overview transaction rows stay concise | Verify no premature column reflow and no nested painted rows | Top actions precede transparent structural columns containing balances→transactions and schedules→people | Two-column columns are centered within the 68rem route and avoid implicit-grid whitespace |
| Group overview / balances loaded | Balance macro-card uses transparent divider-separated rows; sage/coral state is carried by amount text and a restrained accent edge, never a full-row band | Amounts remain prominent at roughly 30–32px without row borders or radii | Balance disclosure remains available and readable | Verify state accents do not become nested cards at the boundary | Main column begins with the balance macro-card | Main-column balance card aligns with the recent-transactions card |
| Group overview / balance loading, error, or offline variants | Focused browser fixture covers the uncached card at 320px | Focused browser fixture covers the uncached card at 390px | Not separately exercised | Not separately exercised | Focused browser fixture covers the uncached card at 896px | Not separately exercised |
| Group overview / fully cached reload | Focused browser fixture reloads cached group, balances, and transactions offline; schedules explicitly remain uncached | Not separately exercised | Not separately exercised | Not separately exercised | Not separately exercised | Not separately exercised |
| Group overview / schedules and people | Populated preview and up to four person rows are visible; uncached-offline copy is announced after reload | Preview rows remain flat and overflow count is explicit; focused loading/error/empty/uncached-offline fixtures run here | Verify schedule actions remain in the disclosure, not the preview | Verify the disclosure remains keyboard and touch usable | Context column places schedules above people without changing focus order | Context cards align with the main column while preserving the mobile DOM order |
| Group overview / secondary actions | Spending insights is direct after primary actions; adjacent native select has closed/hover/focus/picker states and a separate 44px target | Native picker exposes placeholder, history and settings; selection navigates and resets | Verify native picker open/cancel without moving modules | Verify 44px target, secondary colors and focus at 895px | Same native picker at 896px, after primary actions; no inline panel | History/settings remain enabled offline; verify navigation/reset and manual OS picker presentation |
| Expense and schedule forms | Amount hero, split controls, and payer sheet fit without zoom | Payer sheet is bottom anchored and targets remain 44px | Verify form grouping and recurring preview | Verify 895/896 transition without focus loss | Payer dialog is centered; amount remains first | Payer dialog and schedule preview remain readable |
| History and insights | Segmented tabs remain single-line with touch-safe links and contained horizontal overflow when needed; filter disclosure stays in flow; transaction/activity results use divider-separated ledger rows; history and insight outer containers remain flat | Same no-wrap tab treatment; transaction amounts align at row end without painted list containers | Chart/table fallback remains accessible; semantic insight sections remain structural | Verify boundary tab, search behavior, and no painted history/insights ancestor | Desktop rows align like a ledger; filters remain in flow; summary/chart modules are the intentional painted surfaces | Desktop rows align like a ledger; filters remain in flow; summary/chart modules are the intentional painted surfaces |
| Management/settings | Editorial sections remain single-column; deletion is last and is the only tinted contained region; owner, unlinked, and linked member slots fit without overflow | People/invitations/defaults precede exports and destructive actions; member rows keep identity → optional email/invitation → actions order, with one shared action gap | Verify long names and disabled states | Verify boundary spacing and justified form/admin containment | Compact editorial sections preserve hierarchy without stacked cards; Export → Group settings has one stack-owned divider | Compact editorial sections preserve hierarchy without stacked cards |
| Friend/group creation | Focused form surface is one column; add/remove people and cancel remain reachable | Inputs stay at least 16px and action targets stay 44px | Participant rows wrap without reordering | Verify the 895/896 transition does not move submit before fields | Reading-width form stays focused while navigation changes | Long names and invitation copy remain readable |
| Expense edit/schedule edit | Amount, payer, split, recurrence, and submit follow DOM order; payer disclosure stays usable | Recurrence preview and allocation fields do not require horizontal scrolling | Payer controls and weekday choices wrap as groups | Verify focus and dirty/conflict recovery across the desktop boundary | Form surface remains constrained and submit is primary | Schedule metadata and conflict recovery remain adjacent to the form |
| Settlement create/detail and tombstones | Balance rows precede the online-only form; deleted records expose restore only | Amount and from/to controls remain touch-safe | Long participant names wrap in ledger rows | Verify cached balance and connection states remain explicit | Detail actions remain after the accounting summary | History and restore affordances remain secondary to money flow |
| Settings/recovery/public exceptional states | Loading, offline, pending, export, logout, deletion, and recovery copy remain readable in one column | Destructive actions stay last and require explicit confirmation | Cached/offline notices do not block the primary recovery action | Verify banners do not cover focused controls | Administrative surfaces remain distinct without nested cards | Public sign-in, verification unavailable, and private-cache unavailable states retain a clear next action |

Credit flows are online-only and preserve the existing mobile-first form shell.
The browser fixture now includes one active and one deleted persisted credit,
so create, both edit aliases, active detail, deleted detail, and restore
affordances are audited at all six canonical widths. The focused behavior test
checks that a loaded deleted detail disables its restore mutation after an
offline transition; it does not perform the restore.

Group Overview state fixtures are intentionally representative rather than
full-width: schedule loading, API-error, empty, and uncached-offline states are
exercised at 390px, while balance loading, API-error, and uncached-offline
states are exercised at 320px, 390px, and 896px. The fully cached offline
reload runs at 320px. Populated overview geometry runs at all six canonical
widths; Spending insights direct link and More group actions native select closed/hover/focus/open-cancel behavior runs at all six widths in
`insight-people.spec.ts`, with loaded references at 390 and 1440px above.
View all schedules screenshots/disclosure geometry run at **320, 895, 896,
and 1440px**.

The chooser is loaded online first and then switched offline at **320, 895,
896, and 1440px**. Its Expense action remains enabled from the loaded group
context, while Refund/reimbursement and Payment between members are disabled
and explicitly labeled “online only”; no offline mutation is attempted.
Targeted email, generic invitation, Add friend, and party default split
editor disclosures are screenshot-audited for the owner fixture at **320, 895,
896, and 1440px**. The registered member fixture remains covered in its
collapsed management state and is not claimed to have owner-only editors.

## Reliable app update controls

The following matrix includes both executed presentation checks and broader
behavior/lifecycle release checks; the evidence below distinguishes them.
Run each row at **320, 390, 767, 768, 895, 896, and 1440px**.

| View / state | Required checks at every width |
| --- | --- |
| Settings Device: initializing, unsupported, checking, installing | Profile remains first; check control disabled with contextual status; no enabled activation control |
| Settings Device: idle, no-update, cached last-successful check | Check action and last-successful timestamp readable; timestamp not confused with failed attempt |
| Settings Device: offline, check-error, install-error | Offline disables discovery; errors offer retry; existing private cached content remains usable |
| Settings Device and compact header: ready, blocked, applying, deferred | Accessible live status; concise reason wraps without overflow; no force/discard action; all tabs must be safe |
| Expense and refund drafts; payer/install modal | Untouched defaults do not block; changes survive blur/failed submit; modal lifetime blocks activation |
| Group/friend creation; group settings; profile name/avatar | Dirty work remains owned while cached data refreshes; primary save actions precede admin controls |
| Targeted email, generic invite, add-friend, split-default disclosure open/closed | Persistent drafts continue blocking while hidden; reverting semantic values removes draft blocker |
| History filters and Insights dates outside forms | Unapplied changes block, including invalid dates and fields outside form boundaries |
| Settings typed deletion, export, logout, local clear | Failed deletion retains confirmation; complete export/file-picker and provider lifetimes protected |

Focused update-control markup tests cover unavailable/checking/installing/applying,
dirty-blocked discovery, and error retry. Mounted tests cover async profile/refund
initialization, failed saving/validation, semantic reversion and hidden drafts.
The App owner now enables safety after mounting the complete UI inventory and
disables it on cleanup. `tests/e2e/update-settings.spec.ts` executed both tests
at all seven widths: Settings action order/blurred drafts, and all 13 update
phases with distinct local/other-tab reasons (98 presentation configurations).
The status fixtures render the shared production component into the actual
Settings/header slots and verify overflow and enabled/disabled discovery controls;
they do not simulate or claim actual worker discovery/activation behavior.
The combined local update-settings/avatar/user-feedback run passed 11 browser
tests using `/ms-playwright` through the existing local executable resolver.
The separate lifecycle run passed 6 Chromium tests against actual core modules
and coherent production worker/shell artifacts on a real same-origin A/B server.
That dedicated production-core fixture is not an authenticated full-App A/B
audit. The focused date-control run passed 7 Chromium tests. WebKit was unavailable
locally; its verification remains pending CI, with no claim of real iOS Safari
or native-picker coverage from these Chromium runs.
# Consistent update controls

Audit at **320, 390, 767, 768, 895, 896, 1440px** in Settings Device and
the contextual header. Profile and frequent tasks remain before management.

| State | Required presentation at every width |
| --- | --- |
| Automatic ready / blocked / deferred | Header offers only Update now, no persistent waiting announcement; Settings uses neutral availability copy |
| Manual draft / ongoing-save failure | Full reason and save/discard guidance readable, no clipping; action never discards work |
| Manual other-tab / contact failure | Actionable retry help separate from automatic blocker state; long explanation wraps |
| Applying | Updating… only during actual preparation/application; no competing apply action |
| Loading / unsupported / checking / installing | Discovery disabled appropriately; no invented ready action |
| Empty / no update / cached last success | Check action and timestamp remain distinct from availability |
| Offline | Discovery unavailable; installed verified update still offers Update now |
| Ready-offline / blocked-offline | Check for updates disabled independently of availability; installed Update now enabled, connectivity explanation readable |
| Manual identity verification | Waiting/controller verification guidance and retry explanation readable without unrelated draft-discard advice |
| Check / install error | Discovery retry available; available installed update remains independent |

`update-settings.spec.ts` supplies responsive presentation fixtures; production
lifecycle tests cover real captured manual clicks, draft/save refusal and offline
installed application. Verification completed: both focused
Settings tests passed across all seven widths, including all phase fixtures and
short/long manual failure feedback in header and Settings (Chromium).
