# Warm Ledger responsive audit matrix

Canonical audit widths are **320, 390, 768, 895, 896, and 1440px**. The
private shell keeps the mobile bottom navigation through 895px and switches to
the desktop top navigation and two-column group overview at 896px.

The refund/reimbursement matrix below remains the release checklist for the
dedicated online-only refund flow. The Warm Ledger states cover the newer
credit and shell surfaces without replacing those refund-specific checks.

## Automated route coverage

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
| Group overview | Four compact macro-cards appear in DOM order: balances, transactions, schedules, people; More group actions follows collapsed | Same order with two-up full-width header actions, 44px controls, flat internal rows, and native lists | Single-column financial reading order; overview transaction rows stay concise | Verify no premature column reflow and no nested painted rows | Transparent structural columns contain balances→transactions and schedules→people; actions remain below all modules | Two-column columns are centered within the 68rem route and avoid implicit-grid whitespace |
| Group overview / balances loaded | Balance macro-card uses transparent divider-separated rows; sage/coral state is carried by amount text and a restrained accent edge, never a full-row band | Amounts remain prominent at roughly 30–32px without row borders or radii | Balance disclosure remains available and readable | Verify state accents do not become nested cards at the boundary | Main column begins with the balance macro-card | Main-column balance card aligns with the recent-transactions card |
| Group overview / balance loading, error, or offline variants | Focused browser fixture covers the uncached card at 320px | Focused browser fixture covers the uncached card at 390px | Not separately exercised | Not separately exercised | Focused browser fixture covers the uncached card at 896px | Not separately exercised |
| Group overview / fully cached reload | Focused browser fixture reloads cached group, balances, and transactions offline; schedules explicitly remain uncached | Not separately exercised | Not separately exercised | Not separately exercised | Not separately exercised | Not separately exercised |
| Group overview / schedules and people | Populated preview and up to four person rows are visible; uncached-offline copy is announced after reload | Preview rows remain flat and overflow count is explicit; focused loading/error/empty/uncached-offline fixtures run here | Verify schedule actions remain in the disclosure, not the preview | Verify the disclosure remains keyboard and touch usable | Context column places schedules above people without changing focus order | Context cards align with the main column while preserving the mobile DOM order |
| Group overview / secondary actions | More group actions is collapsed after people; quiet links remain discoverable | Disclosure keeps insights, credit, history, and settings below primary content | Verify no large tools surface competes with the four modules | Verify summary target and link rows remain at least 44px | Actions stay below both structural columns | Secondary actions remain progressively disclosed and visually quiet |
| Expense and schedule forms | Amount hero, split controls, and payer sheet fit without zoom | Payer sheet is bottom anchored and targets remain 44px | Verify form grouping and recurring preview | Verify 895/896 transition without focus loss | Payer dialog is centered; amount remains first | Payer dialog and schedule preview remain readable |
| History and insights | Segmented tabs remain single-line with touch-safe links and contained horizontal overflow when needed; filter disclosure stays in flow; transaction/activity results use divider-separated ledger rows; history and insight outer containers remain flat | Same no-wrap tab treatment; transaction amounts align at row end without painted list containers | Chart/table fallback remains accessible; semantic insight sections remain structural | Verify boundary tab, search behavior, and no painted history/insights ancestor | Desktop rows align like a ledger; filters remain in flow; summary/chart modules are the intentional painted surfaces | Desktop rows align like a ledger; filters remain in flow; summary/chart modules are the intentional painted surfaces |
| Management/settings | Editorial sections remain single-column; deletion is last and is the only tinted contained region | People/invitations/defaults precede exports and destructive actions; member rows remain flat ledger rows | Verify long names and disabled states | Verify boundary spacing and justified form/admin containment | Compact editorial sections preserve hierarchy without stacked cards | Compact editorial sections preserve hierarchy without stacked cards |
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
widths; More group actions and View all schedules screenshots/disclosure
geometry run at **320, 895, 896, and 1440px**.

The chooser is loaded online first and then switched offline at **320, 895,
896, and 1440px**. Its Expense action remains enabled from the loaded group
context, while Refund/reimbursement and Payment between members are disabled
and explicitly labeled “online only”; no offline mutation is attempted.
Targeted email, generic invitation, Add friend, and party default split
editor disclosures are screenshot-audited for the owner fixture at **320, 895,
896, and 1440px**. The registered member fixture remains covered in its
collapsed management state and is not claimed to have owner-only editors.
