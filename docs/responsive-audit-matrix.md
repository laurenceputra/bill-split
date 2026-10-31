# Responsive audit matrix

## Refund balance explanations

Required widths for every row: **320, 390, 767, 768, 895, 896, 1440px**.
Keep the same mobile DOM order; recording/saving remains before cancellation,
and editing a saved record remains before deletion. No accounting rules changed.

| View / meaningful state | Responsive and behavior checks |
| --- | --- |
| Create: incomplete/invalid draft, default recipient, original split | No projected amounts until complete; validation and primary action remain reachable without horizontal overflow. |
| Create: complete member receipt, genuine two-person group | One named after-saving outcome per affected currency, with up/down/current outcome subtext for sign crossing and zero. Unchanged amounts say Balance unchanged. Validate complete opposite raw balances. |
| Create: larger group, including historical/removed or raw-ledger identities, only two affected people | Compact per-person current → after balances, never infer a pairwise debt from the affected subset. |
| Create/edit: calculation disclosure closed/open | Semantic How is this calculated? disclosure hides calculation and separate-payment guidance by default. Latest-loaded draft projection, not historical totals. Short payment note remains visible; no duplicate refund/applied totals when fully applied. |
| Create: adjusted beneficiaries, overlapping/multiple recipients | Beneficiary controls remain operable; net effects combine receipt and cost reduction; multi-party help is generalized inside calculation disclosure. |
| Create: provider offset / standalone | Offset explains payment reduction, not a new receipt; no separate-payment help. Standalone has no invented original payer. |
| Create/edit: loading, stale, cached offline, cached/cold error | Projection unavailable (never zero); refresh control disabled offline/loading, available online. Reconnect and refresh restore projection only with fresh resources. |
| Create/edit: loaded response missing person/currency | Explicit balance unavailable for that person/currency, never fabricated settled/zero. |
| Edit: unchanged and changed saved allocations; currency change | Subtract saved snapshot then add draft, currency by currency. Unchanged edit keeps current balance. Clearly latest-loaded projection after saving, not historical totals. |
| Edit: background refresh discovers a newer saved revision | Preserve draft and its original optimistic token; show conflict warning and saved-record link, hide projection and transfer guidance. Saving must not silently overwrite the newer revision. Required at all widths above; mounted unit regression verified, responsive conflict layout remains planned. |
| Saved detail: member receipt, provider offset, historical names | Effects come only from persisted allocations, never current expense splits. Explain receipt versus cost reduction and offset versus member payment; no historical before/after totals. |
| Saved detail: audit disclosure closed/open, cached/offline/error | Readable snapshot explanations remain distinct from current balances; edit precedes delete, offline writes disabled. Names retain historical/fallback labels. |
| Saved detail: deleted | Tombstone explicitly has no active effects; restore action only, no active effect list. |
| Inline money: partially applied refund total, saved detail total, insight Your share/You paid, schedule amount + cadence | At all required widths, amounts share the surrounding prose baseline, including when the detail label wraps. Preserve nowrap, contained horizontal scrolling and overflow-only keyboard focus. Flex/grid amount layouts are unchanged. |

**Verified automated coverage:** `tests/e2e/linked-refund.spec.ts` checks create
validation, beneficiary and calculation disclosures, recipient overlap, sign crossing/zero, two-person versus historical three-person groups, cached
offline suppression and reconnect/reload, missing/error balances,
unchanged/changed standalone edits (including USD → EUR → USD), saved member
receipt snapshots, audit disclosure, and deleted records across required widths.
It checks horizontal overflow and reachable create actions. Unit tests cover zero
crossings, explicit current-person grammar (including another person named You),
transfer wording, saved allocations versus changed linked expense splits, and
provider mode. Mounted fake-clock regressions verify expired saved-credit and
off-first-page selected expense snapshots: both must refresh before projection or
guidance returns, either completion order is safe, latest expense snapshots
replace older ones, and dirty note/applied amount fields are preserved.
The newer-revision regression changes saved totals and allocations and verifies
that the preserved v1 draft still submits version 1 after v2 loads, surfaces a
save conflict, and never presents a safe-looking projection for the stale edit.
The focused Chromium refund suite plus online/offline submission audit pass.
The broad normal-route refund audit was attempted separately: completed 320/390px
states (including calculation open) report zero product findings, but Wrangler
exits unexpectedly at the 768px context, so the remaining broad audit is not
claimed as verified. Disclosure paragraph spacing is also measured at every
focused create width in `linked-refund.spec.ts`.

Inline baseline regressions in `linked-refund.spec.ts` (synthetic create/detail)
and `tablet-layout.spec.ts` (live schedule prose and an insight-shaped fixture
using a rendered Money clone; the non-personal insight branch is not currently
mounted by a route) measure actual browser text baselines at all required widths.
Shared `.money` uses `vertical-align: bottom` to align line boxes despite the
scroll container's bottom-edge baseline;
`middle` was visually compared but centers on the font's x-height rather than
matching text baselines. Existing safe-integer and below-threshold overflow
browser checks and `money-ui.test.tsx` retain keyboard-scroll/focus coverage.

**Planned/manual coverage, not claimed as verified:** all-width provider-offset
saved detail and historical-name layouts; saved-detail cached/offline/error
variants; delayed initial balance loading; explicit refresh-button recovery from
errors; and a UI-driven paginated selection followed by TTL expiry (the mounted
regression currently covers selected detail-loaded expenses outside page one).
The table above lists audit requirements, not a claim that every combination was
exercised. No Firefox/WebKit or native-device run is included.
Synthetic mobile/desktop evidence is refreshed with
`REFUND_SCREENSHOTS=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e:local -- tests/e2e/linked-refund.spec.ts --project=chromium --workers=1`.
Images: `refund-improvements-*-mobile/desktop.png`,
`refund-explanations-edit-390/1440.png`, `refund-explanations-detail-390/1440.png`.
New reference pairs include `refund-improvements-calculation-open-*` and
`refund-improvements-larger-group-*`.
All captures use Demo user / Demo friend / Sample purchase only.

## Shared personal balance verification

At 320px, 767/768px, 895/896px, and desktop, audit the existing Home cards
(including Outstanding first), group overview, expanded full breakdown, and
settlement form. Home and overview use the same user/group revisioned complete
personal snapshot; zero and removed currencies must replace earlier values.
Legacy caches remain usable without claiming a capped summary is complete.

Cover cold loading, empty/settled, cached offline, background refresh, cold error,
and cached error. Keep Add expense before management. Full breakdown is a separate
resource: if its revision trails the personal snapshot, retain its cached display
with stale status and refresh it; never prefill an actionable stale suggestion.
Polling must stop while hidden, offline, or authentication is restoring. Cross-tab
hints contain only an opaque event ID and user/group scope, never balance amounts.
Verify a dirty settlement draft survives background refresh and pair changes.
`canonical-balances.spec.ts` checks 320px, 768px, and 1280px canonical-only
cards with a pending, failed, then offline breakdown, including its expanded
disclosure. Home ranks the complete map by absolute amount before showing two
currencies; overview retains all currencies, including a default-currency zero.
Settlement currency/pair changes update automatic amounts; manually typed amounts
survive refresh. Settlement edits retain their draft while a newer breakdown is
pending and must never consume stale/offline suggestions.
These checks extend the existing matrix; new screenshot captures were not generated
for this data-source-only change.

## Boundaries and audit scope

Keep frequent tasks before administration, preserve mobile DOM/focus order,
and disclose secondary work progressively. Center containers, not their text.
Loading, cached, offline, empty, cold-error, and stale-error states must remain
distinct; do not invent choices, totals, or enabled mutations without valid data.

| Boundary | Current contract |
| --- | --- |
| Home: 767 / 768px | Exactly one column below 768px, two from 768px, including skeletons |
| Shell/group: 895 / 896px | Bottom navigation and single-column group detail through 895px; desktop navigation and two structural columns from 896px |
| Shared app sheets: 767 / 768px | Mobile bottom sheet below 768px; every shared sheet centers from 768px, independently of navigation |
| Route containers | Home/group center within 68rem; History heading, back link, filters, tabs, notices, Changes/Transactions/Insights results share one centered 42rem reading stack |
| Chooser: 599 / 600px | Actions stack below 600px, then wrap in a row |
| Person totals: 639 / 640px | Labeled stacked metrics below 640px; Person / Allocated share / Paid columns from 640px |
| Refund allocations: 895 / 896px | Person → amount → remove stack below 896px; two spacious columns with removal on its own row on desktop |

Names wrap within their own containers. Displayed money remains an indivisible
currency/amount token: no ellipsis, hidden digits, or wrapping inside the token.
Oversized Money uses **local** horizontal scrolling, not page overflow. Only
actual `scrollWidth > clientWidth` overflow makes it keyboard-focusable, with
resize/font updates and cleanup; fitting values stay outside the tab order.
Home balances stack labels/money at their own container width of 20rem or less.

The twelve-width geometry set is **320, 390, 767, 768, 820, 834, 895, 896,
1024, 1180, 1194, 1440px**. It belongs to the tablet/layout fixtures, not every
existing suite. Widths and fixture scopes below describe test definitions;
they are not a claim every release-check permutation passed in this revision.

## Surface and state matrix

Apply each row at narrow mobile, its relevant boundary, and desktop. Additional
widths are defined by the owning suite in the next section. Check containment,
44px action targets, readable help/errors, and primary-before-admin order with
normal navigation visible before any capture-only hiding of fixed navigation.

| Surface / meaningful state | Required behavior and layout |
| --- | --- |
| Public front / signed out | Centered container, left-aligned copy; sign-in before secondary sign-up/install actions; generic decorative ledger |
| Public exceptional states | Verification unavailable, private-cache unavailable, and pending account deletion each offer a truthful next action; banners do not cover focus |
| Home / loaded | Content-height linked cards, wrapped long names, complete multi-currency balances; Add friend / New group before Sort and cards |
| Home / cold loading | One/two-column skeleton matches loaded grid; no Sort or fabricated group links |
| Home / empty, uncached error | Creation actions for empty data; error/retry for failed data; no irrelevant Sort |
| Home / cached refresh error | Cached cards and sorting remain usable; one contextual notice/retry, no duplicate notices |
| Home / already-loaded offline | Both sort modes/help remain usable without requests; no impossible online Retry |
| Home / Sort help closed/open | Name mode has no help trigger; Outstanding mode has described text-only tooltip, contained open state, independent keyboard/touch target |
| Group overview / loaded | Add expense and Settle up precede Spending insights and More group actions; balances → transactions → schedules → people preserve mobile DOM order |
| Group / long names, large balances | Centered route; single macro-column through 895px; indivisible money locally scrollable if needed; full breakdown closed/open contained |
| Group / balances loading/error/uncached offline | No invented balance; card-local status/retry stays adjacent; surrounding valid content remains usable |
| Group / fully cached offline reload | Cached group/balances/transactions remain; genuinely uncached schedules say so rather than claiming a fully cached App |
| Group / schedules loading/error/empty/offline | Distinct preview states; View all schedules disclosure keeps actions inside it; preview count is explicit |
| Group / More actions closed/hover/focus/native open/cancel | Separate 44px secondary select beside direct Insights link; placeholder/history/settings only; no inline panel or title/card movement |
| Group / unavailable, cold loading/error | Existing placeholder/retry views, no management actions without authorized group data |
| History / Changes | Back to group only for an authorized selected group, before filters; all route pieces share centered reading width |
| History / Transactions, Search and filters closed/open | In-flow disclosure, complete labels; refund filter omits expense-only category controls; keyset results preserve detail/group links |
| History / Insights, preset/custom period | Same centered reading stack, including summary/chart; selected-currency totals and custom from/to/Apply range remain contained |
| History / loading/empty/cold error | No invented results/person totals; empty suppresses person list; error exposes retry |
| History / cached/offline/stale error | Cached totals/results retained with notices; older summaries without people omit that list until refreshed |
| Insights / Spending by person | Name/winner identity together; allocated share and paid separately labeled; positive ties allowed, all-zero data has no winner |
| Insights / long names/large values | Person block capped at 48rem without narrowing charts; names wrap, money stays intact and locally scrollable |
| Global Add / unselected, selected, switched | One labeled native Group/person selector and one expense-first action set; destinations follow valid selection |
| Global Add / one group, removed selection | One valid group autoselects initially; removing a selected group clears it and disables actions, never silently redirects |
| Scoped Add / loaded, unavailable | Immediate actions with heading, no dropdown; completed-unavailable group has no action set; delayed lookup is not unavailable |
| Add / loading/empty/cold error | No invented choices; empty offers creation links; cold error offers retry |
| Add / loaded offline/cached refresh error | Expense stays available with trusted loaded context; refund/payment online-only; cached refresh errors retain selection with one notice |
| Split Add navigation / inactive/active/hover/focus | Expense-first primary segment and native alternative select remain joined; mobile raised tile contained with safe-area decorative extension |
| Friend/group creation / people disclosure | One readable form; add/remove/cancel reachable, long names/invitation help wrap; primary submit after fields |
| Expense new / normal/long/very-long amount | Joined currency/amount shell, independent labels/focus, 44px targets; long-value fallback stacks without losing native editing access |
| Expense / Repeat off/on monthly/on weekly/off again | Date before payer/split; recurrence settings directly after Repeat; same date node/draft survives toggles |
| Expense / recurrence custom timezone | Start/end, weekday choices, preview/help contained; schedule-only submission does not create an immediate expense |
| Expense edit / schedule edit | Date precedes payer; schedule settings follow Start date with no Repeat checkbox; conflicts/dirty recovery remain adjacent |
| Expense / loading/unavailable/empty target | Distinct loading/retry/create-target states; no date or impossible save action without target data |
| Expense / cached/offline | Cached group retained; online-only recurring save disabled with contextual explanation |
| Shared payer sheet / open/added payer/short height | Bottom sheet or centered per 768px boundary; dynamic viewport/safe-area bounds; local vertical scroll, Done reachable at 360px height; Escape closes |
| Other shared sheets / install/help/allocation open/busy/error | Same centering and short-height bounds; verify actual content, focus return and busy/error states separately |
| Refund / loading/cached/offline/error/conflict | Messages beside form, online-only submission; stale expense capacity/shares refresh without silent allocation loss |
| Refund / linked member/standalone member/linked provider | Source/handling help associated; standalone provider adjustment unavailable; mode changes preserve a valid standalone state |
| Refund / expense picker open/search/paged | Date/gross/refunded/remaining context readable; fully refunded rows unavailable; linked currency locked |
| Refund / blank-submit/corrected draft | Control-local blur validation; submit reveals all errors and focuses first invalid control; unrelated note/source blur does not expose untouched errors |
| Refund / default recipient/full total/manual override | New-only current-member default/hint, sole eligible fallback or blank; full-total following until manual change; explicit full/remaining resets |
| Refund / added/multiple recipients | Added rows blank; complete existing blank row before Add; eligible-member limit; remaining/overallocated status stays near rows |
| Refund / beneficiaries closed/open/original-split reset | Custom snapshot preserved when reopening; supported reset uses read-only server-derived shares; unsupported inactive-share changes blocked with actionable help |
| Refund / saved edit/historical members | Saved recipients stay manual until Use full total; inactive derived shares must exactly match saved person/type/minor amount, including after reset |
| Refund / all manual beneficiaries removed | Stable aggregate error separate from total validity; submit focuses Money flow; Add affected member/original split recovery reachable |
| Refund / balance preview | Valid complete fresh drafts only. Genuine two-person group with complete opposite raw balances gets one named outcome per currency; all other groups get compact per-person current → after balances. Historical/removed/raw identities prevent unsafe pairwise inference. |
| Refund / different recipient and calculation disclosure closed/open | Generic Demo friend / Sample purchase; sign crossing, settled and unchanged outcomes, invalid-preview suppression; calculation and applicable separate-payment help inside semantic disclosure. |
| Expense detail / linked refunds | Gross/refunded/net/remaining, linked rows and Add refund in reading order; long notes wrap |
| Credit/refund detail / active/deleted/restore | Accounting summary before edit/delete/audit; tombstone exposes restore only, disabled offline; conflict feedback adjacent |
| Settlement / create/edit/detail/tombstone | Balance before online-only form; from/to/date touch-safe; restore/history secondary to accounting summary |
| Management / owner/member/invitations/defaults | People/invitations/defaults before export/destructive work; identity → optional email/invitation → actions; hidden drafts retain ownership |
| Management / destructive states | Deletion last, explicit confirmation; unavailable owner-only editors not fabricated for members; disabled states explained |
| Settings / Profile, avatar choice/preview/error | Profile before Device/admin; loading identity disables Save; failed save preserves choice; missing image falls back to initials |
| Settings / cached/offline avatar | Saved preference retained, no offline image requests; save unavailable with help; unverified identity uses auth recovery rather than editable profile |
| Settings / export/logout/local clear/deletion | Full operation/provider/file-picker lifetimes protected; failed deletion retains typed confirmation; banners do not cover controls |
| Update / initializing/unsupported/checking/installing | Discovery appropriately disabled, no fabricated ready action; Profile still first |
| Update / idle/no-update/cached last success | Check and last-success timestamp distinct from availability and failed attempts |
| Update / ready/blocked/deferred | Header offers Update now without persistent automatic waiting announcement; neutral Settings availability, no force/discard action |
| Update / manual draft/save/other-tab/contact failure | Actionable wrapping help separate from automatic blocker state; action never discards work |
| Update / applying | Updating only during preparation/application, no competing apply action |
| Update / offline/ready-offline/blocked-offline | Discovery disabled independently; installed verified Update now remains available; no connectivity-based force bypass |
| Update / check/install error, identity verifying | Retry help; installed availability independent; unverified identity never presented as current or ready |
| Update / dirty forms/disclosures/filters/modals | Untouched defaults do not block; dirty work survives blur/failed save/hidden disclosure; unapplied invalid dates outside forms also block |
| Diagnostics / closed/open/verified/unavailable | Primary update/check before disclosure; click/Space/Enter; long immutable build strings bounded; missing identity Unavailable, pending Not yet verified |
| Recovery / unsaved profile/new tab | Isolated noopener/noreferrer tab preserves original typed profile; guidance includes closing recovery tab |
| Recovery / standalone online/offline | Save/finish writes → close all → reopen; normal return link; no App/scripts/IDB; offline fails rather than claims success |

## Automated suites and their widths

Do not extrapolate a shared CSS rule or a screenshot into every route/state.
The owning tests define the actual width sets and distinguish loaded geometry,
presentation injection, resource states, and real worker lifecycle behavior.

| Suite | Widths / focused scope |
| --- | --- |
| `tablet-layout.spec.ts` | Six test declarations; twelve-width group/History disclosure geometry, public front, payer/short sheets; separate 320px safe-limit and actual-overflow Money cases |
| `home-insights-surfaces.spec.ts` | Core Home/sort at 320, 390, 768, 895, 896, 1440; additional twelve-width layout/state fixtures; global/group chart paint at 390/1440 |
| `insight-people.spec.ts` | Person geometry at 320, 390, 639, 640, 768, 895, 896, 1440; group secondary control/context at six canonical widths; focused period/currency/resource states |
| `transaction-chooser.spec.ts` | 320, 390, 599, 600, 768, 895, 896, 1440 for selected/unselected/offline geometry; targeted 320px loading/removal/cache/empty/error transitions |
| `control-feedback.spec.ts` | Pure production controls at 320, 390, 895, 896, 1440; deterministic button/auth/install/update/banner props, not provider modal execution |
| `linked-refund.spec.ts` | 320, 390, 480, 481, 767, 768, 895, 896, 1440; validation/focus, following/reset, beneficiaries, multiple recipients, long decimals, named outcomes, calculation disclosure, sign crossing/zero; historical three-person fallback and currency edits at canonical seven widths |
| `avatar.spec.ts` | 320, 390, 767, 768, 895, 896, 1440; preference/preview/persistence/fallback/loading/error/cached offline restrictions; external avatar requests intercepted |
| `update-settings.spec.ts` | Original phase/draft presentation at 320, 390, 767, 768, 895, 896, 1440; diagnostics/recovery additionally 834/1024 (nine widths) |
| `service-worker-update.spec.ts` | Standalone same-origin production-core A/B lifecycle; recovery page at nine recovery widths; not authenticated full-App A/B migration |
| `date-controls.spec.ts` | Thirteen route behaviors once at 390; eight representative geometries at 320, 390, 767, 768, 895, 896, 1440; Chromium and dedicated WebKit project |
| `expense-amount-layout.spec.ts` | 320, 390, 767, 768, 895, 896, 1440; normal/long/very-long values, shell geometry, focus and native editing access |
| `scheduled-expense.spec.ts` | Focused recurrence adjacency/node identity, preserved fields/settings, edit modes and schedule-only submission |
| `audit.spec.ts` | Normal routes at 320, 390, 768, 895, 896, 1440; recurrence additionally 767; focused disclosures at 320, 895, 896, 1440 |
| `accessibility.spec.ts` | Representative route semantics/states; mobile Add geometry at 320, 390, 399, 400, 430, 447, 448, 480, 481, 600, 767, 768, 895, plus desktop transition |
| `group-reference-screenshots.spec.ts` | Opt-in loaded synthetic references at 390×844 / 1440×900; capture evidence, not independent full route-state coverage |

Tablet definitions exercise Home loaded/loading/empty/error/cached-error/offline
help, group breakdown, Changes, expanded Transactions, custom Insights, payer
rows, public alignment, and money containment. The 320px safe-integer test uses
signed `Number.MAX_SAFE_INTEGER` minor amounts across Home/group/Transactions/
Insights. The separate actual-overflow test uses 999999999999 minor units in
large group typography, checks tabindex/ArrowRight/end access, removes focusability
at 1440px, and restores it on return to 320px. Complete text stays in the DOM.

Group resource fixtures are representative: schedule loading/error/empty/uncached
offline at 390px; balance loading/error/uncached offline at 320/390/896; fully
cached financial reload at 320, with schedules explicitly uncached. View all
schedules and owner email/invite/add-friend/default-split disclosures use
320/895/896/1440. Cached person-summary persistence is same-session, not a cold
offline reload. Registered-member collapsed management is not owner-editor coverage.

Route audit families include public/populated/empty Home; friend/group creation;
global/scoped Add; owner/member group management; expense create/edit/schedule
edit and payer sheet; refund create/edit/credit alias and active/deleted details;
settlement create/detail/tombstone; group/global Changes/Transactions/Insights;
and Settings. Use fixture IDs from `audit.spec.ts`, not copied production routes.
Internal example.com auth contracts must never appear in captures.

Focused behavior audits also cover filter semantics, deletion typing/order,
invitation disclosure, restore controls, and offline-disabled refund form/detail
actions. The development auth fixture does not submit account deletion; the
deleted-credit offline case checks disabled restore, not successful restoration.

## Special controls, native UI, and manual limits

### Sort tooltip and control feedback

Sort is per-account, numeric/case-insensitive by display name by default.
Outstanding sorting compares absolute minor amounts without currency conversion,
uses default-currency zero fallback, and retains stable name/ID ties. Helper/hook
tests cover absent/empty/unsettled summaries, immutability, unavailable/throwing
storage, and account switches. Reload retains preference but closes the tooltip.

The info glyph is raised after Sort with a 2px gap and compact label row.
Its separate 44×44 target extends into header clearance without overlapping
actions/select/label. Target stays transparent in hover/press/focus/touch; only
the stationary glyph paints feedback and its rounded 1px focus outline.

Hover (including tooltip text), focus, and click/tap combine with pinned state.
Repeated activation closes pinned help even with focus; blur while hovering
text retains it, and text selection/taps do not dismiss. Escape/outside pointer
dismiss and suppress existing hover/focus until fresh entry/focus/activation.
Touch-enabled 390px coverage supplements desktop event checks, not real-device
verification. Tooltip describes the default/fallback and no-conversion behavior.

Native primary paint is opt-in via `.button` / `.ui-button`; secondary/danger/
quiet variants retain their own feedback. Payer summaries, selected/unselected
participants, currency tabs, Retry, install/update and auth-banner actions retain
their semantic foreground/background on hover/press. Disabled/busy controls
remain disabled. Pure presentation fixtures use production components/theme;
their arranged/static banners prove control paint, not live-route/provider flow.
ErrorBoundary Reload is covered by source/shared-class rules, not its own mount.

### Native selects, dates, and amounts

More group actions is browser/OS picker UI, not an inline disclosure. Automated
Alt+ArrowDown/Escape, DOM options, navigation, and placeholder reset do not verify
popup appearance or touch selection. History/settings remain enabled offline;
server-only transaction alternatives do not. Manually inspect target browsers.

Mobile Add uses a `clamp(100px, 25vw, 112px)` center column, raised about 8px.
Its decorative safe-area extension must not shift interactive geometry. Keep
shared 20px icons, 4px label gap, aligned baselines, square lower corners, and
visible 1px white divider through hover/active and both segment-focus states.
Each segment/neighbor meets its minimum target dimensions. Query-only global
History keeps Add global until selected-group validity is established.

Native date geometry checks initial/empty/populated controls against every
containing ancestor, plus ISO retention after blur. No clipping or replacement
picker hides overflow. Expense create/edit, recurring create/schedule edit,
refund create/edit/credit alias, settlement create/opened edit, expanded global/
group filters, and custom global/group Insights retain route-specific wiring.
End minimum and Apply range belong to the once-per-browser behavior pass, not
every geometry visit. Schedule-start empty rendering is exercised without
changing the draft because its preview expects a valid start.

Expense amount shares Description's border/background/radius. Currency occupies
a fixed 104px segment; normal amount type is 28px (24px for long values).
Very-long values stack with a horizontal divider and type at least 16px.
Children retain independent labels/tab stops; focus-within and validation/forced
colors cover the outer shell. Nine/fifteen-character thresholds remain tested.
Oversized native input text may scroll internally: test full value retention,
Home/End caret access and left-aligned blur reset, not simultaneous visibility.
Refund decimals use the same amount shell, 0.00 placeholder, length classes,
and focus/error treatment; geometry checks >100px visible input width and 1px
unfocused composite border. Linked/allocation currency is static; standalone
currency is editable.

### Manual release checks

- Exercise each meaningful modal/disclosure state with keyboard and touch,
  including short-height scroll, focus return, busy/error and retained drafts.
- Spot-check install/help/allocation content, not just inherited sheet CSS.
- Verify real iOS Safari native date/select presentation, localized values,
  touch/focus, virtual-keyboard and safe-area behavior on devices.
- Verify provider authentication/install prompts and screen-reader announcements.
- Extend representative resource-state fixtures where the changed route needs
  cold offline, cached refresh, empty, or conflict coverage.
- Do not infer worker activation/outbox safety from responsive presentation.
  See [reliable update core](reliable-update-core.md) for ownership/protocol limits.

Linux WebKit is not iOS Safari. Other-engine, device, screen-reader and native
popup checks remain unverified unless separately recorded for the release.

## Screenshot inventory and regeneration

All tracked evidence lives in `docs/screenshots`. Use exclusively synthetic,
generic data such as Demo user, Demo friend, Sample project and Sample purchase.
Sanitize fixture/API names, free text, email and avatar metadata **before**
rendering; assert text/avatar identity before capture. Do not use real data,
personal-looking identities, personal initials/hashes, or blur as anonymization.
Await fonts and disable animations for repeatability.

| Generator / reference family | Inventory and capture scope |
| --- | --- |
| Home | `home-{mobile,desktop}`, `home-sgd-stress-{mobile,desktop}`, `home-outstanding-{mobile,desktop}`, `home-outstanding-closed-{mobile,desktop}`; focused help and mobile-tapped supplements |
| Controls | `control-feedback-{summary,participant,public,install,updates,banners}-{mobile,desktop}`; production controls, not provider-native prompts |
| Group | `warm-ledger-{mobile,desktop}`, `group-overview-mobile-viewport`, `group-overview-more-actions-focused-{mobile,desktop}`; loaded overview and native select focus, not OS popup |
| History/Insights | `warm-ledger-history-{mobile,desktop}`, `spending-insights-{global,group}-{mobile,desktop}`; canonical loaded all-time USD summaries |
| Expense | `expense-form-{mobile,desktop}`, `expense-form-recurring-{mobile,desktop}`; loaded one-time/monthly form |
| Refund | Ten `refund-improvements-{default,validation,allocations,empty-beneficiaries,different-recipient}-{mobile,desktop}` captures; generic recipient/purchase states |
| Tablet | 23 curated `tablet-*` references; exact allowlist in `tests/e2e/tablet-evidence.ts`, not every exercised width/state |
| Recovery | `update-recovery-{390,834,1440}` standalone page and `update-diagnostics-{390,834,1440}` isolated verified production disclosure |

Names above omit `.png`. Validate the final generated inventory before release.
No removed reference should be reintroduced. Screenshots are selected evidence,
not proof that uncaptured states or all suites passed.

The tablet allowlist includes Home loaded/loading/empty/error/cached-error/
offline help; group/breakdown/safe-limit; Changes/expanded Transactions/Insights/
custom dates; payer/mobile/tablet short sheets; and public front. Short sheets
use 360px height. `UPDATE_TABLET_SCREENSHOTS=1` writes only allowlisted references;
`TABLET_SCREENSHOT_ARTIFACTS=1` writes optional exhaustive outputs/attachments
outside tracked docs. Normal stress amounts are synthetic 9,876,543.21.

Group captures anonymize local ledger/API identity and assert generic avatars.
Mobile full-page capture may hide fixed bottom navigation **after** live layout
checks, avoiding repeated/obscuring stripes; the explicit viewport reference
retains it. Tablet captures keep navigation visible. Isolated diagnostics may
hide it only for capture; behavior checks retain normal navigation.

Run from the repository root; the local resolver uses `/ms-playwright`. Use
separate free ports and persistence directories for concurrent local servers.
Capture flags opt into tracked writes; normal behavior tests do not refresh PNGs.

```sh
# Home and control evidence
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:screenshots:home
UPDATE_HOME_SCREENSHOTS=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e:local -- tests/e2e/control-feedback.spec.ts --project=chromium --workers=1

# Group references; optional bounded refreshes avoid unrelated churn
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:screenshots:group
GROUP_SCREENSHOTS_OVERVIEW_ONLY=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:screenshots:group
GROUP_SCREENSHOTS_SKIP_HISTORY=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:screenshots:group

# Curated twelve-width layout/state evidence
UPDATE_TABLET_SCREENSHOTS=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright BILLSPLIT_E2E_PORT=8798 BILLSPLIT_E2E_PERSIST_DIR=/tmp/bill-split-playwright-tablet npm run test:e2e:local -- tests/e2e/tablet-layout.spec.ts tests/e2e/home-insights-surfaces.spec.ts --project=chromium --workers=1

# Expense and generic refund references
UPDATE_EXPENSE_SCREENSHOTS=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e:local -- tests/e2e/audit.spec.ts --grep 'expense date recurrence responsive audit' --project=chromium --workers=1
REFUND_SCREENSHOTS=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e:local -- tests/e2e/linked-refund.spec.ts --project=chromium --workers=1

# Recovery page and Settings diagnostics
UPDATE_RECOVERY_SCREENSHOTS=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node scripts/test-update-lifecycle-local.mjs
UPDATE_RECOVERY_SCREENSHOTS=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright BILLSPLIT_E2E_PORT=8799 BILLSPLIT_E2E_PERSIST_DIR=/tmp/bill-split-playwright-recovery npm run test:e2e:local -- tests/e2e/update-settings.spec.ts --project=chromium --workers=1
```

Audit screenshots/findings outside curated references remain ignored in
`test-results/audit/normal` or `test-results/audit/intercepted`. Existing long
participant labels intentionally ellipsize in some allocation controls; record
that limitation separately from displayed Money and date containment.

## Verification and release checks

Current uncommitted worktree verification passed: **987 full-suite unit tests,
27 integration tests, 1 migration test, and 12 standalone Chromium lifecycle
tests**, plus production build (including typecheck) and `git diff --check`.
The generic refund cleanup also passed **45 focused unit tests and 3 Chromium
tests**, exercised its nine-width matrix, and regenerated ten synthetic PNGs.
Focused unit results are not additional to the full-suite total.

Prior Settings/update/avatar/feedback and tablet layout evidence remains
prior-only; those suites were not rerun in this pass. No full route audit,
other-engine, iPad/iOS, native-picker, provider, or screen-reader pass is claimed.
The build retains its existing large-chunk warning; manual release checks remain.

Recovery evidence uses a pinned cache-first worker controlling a static,
script-free shell. Normal navigation retains its cached marker; recovery reaches
network instructions without App assets or IndexedDB opens/databases; offline
navigation rejects. This proves network bypass, not historical App IDB migration,
production pending-expense preservation, authentication or replay. Existing legacy
lifecycle cases retain a synthetic adapter and fixture-owned queued row.

Update presentation injects the shared production component into Settings/Header
slots: phases and local/other-tab blocked variants across the suite's seven
phase widths, plus manual feedback and nine-width diagnostics.
It does not simulate worker discovery/activation. Recovery profile preservation
uses 390px; standalone recovery containment uses the nine recovery widths, not
all twelve tablet widths.

Before release:

1. Run typecheck/build, unit and integration/migration suites; retain the existing
   large-chunk warning as a known build warning, not a test failure.
2. Run relevant focused browser suites with the source-defined width sets,
   including every changed meaningful disclosure/modal and resource state.
3. Regenerate changed tracked references using generic fixtures, verify final
   inventory/text/avatar identity, and visually inspect narrow and desktop captures.
4. Run the full route audit where changes affect shared layout/navigation;
   inspect containment findings rather than accepting screenshot presence alone.
5. Run real update lifecycle/recovery checks separately from presentation;
   perform deployed artifact/header smoke checks from the integration contract.
6. Record pending manual device/native/provider/screen-reader checks explicitly.

```sh
npm run typecheck
npm run test:unit -- --maxWorkers=2
npm run test:integration
npm run build
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node scripts/test-update-lifecycle-local.mjs
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e:local -- tests/e2e/update-settings.spec.ts tests/e2e/avatar.spec.ts tests/e2e/user-feedback.spec.ts --project=chromium --workers=1
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e:local -- tests/e2e/tablet-layout.spec.ts tests/e2e/home-insights-surfaces.spec.ts tests/e2e/insight-people.spec.ts tests/e2e/linked-refund.spec.ts --project=chromium --workers=1
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e:local -- tests/e2e/date-controls.spec.ts --project=chromium
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e -- tests/e2e/date-controls.spec.ts --project=date-controls-webkit
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:e2e:local -- tests/e2e/audit.spec.ts --project=chromium --workers=1
git diff --check
```

WebKit requires its matching installed browser/host dependencies. No browser
installation is implied by these commands. A runtime exit/connection-refused
run is not passing evidence; rerun successfully and report its exact scope.

# Whole-field native date activation

`tests/e2e/date-controls.spec.ts` verifies trusted body clicks (away from the
calendar icon) request the native picker synchronously, while focus alone does
not. Covers expense create/edit, repeat start/end disclosure, schedule edit,
refund create/edit and credit alias, settlement create/edit disclosure, group
and global expanded transaction filters, and group/global custom insights.
Geometry and body-click coverage samples 320, 390, 767/768, 895/896 and 1440px;
all route variants also run at 390px. Existing empty/populated values, required
fields, end-date minimum and custom-range application checks remain intact.

Shared DateInput unit coverage includes disabled/read-only, cancelled clicks,
missing/throwing picker APIs and native prop forwarding. Offline transaction
filters retain disabled dates; cached editable forms keep native date editing.
Loading, empty and error rendering, action order and native date styling are
unchanged. No custom calendar or focus-triggered popup is introduced.
