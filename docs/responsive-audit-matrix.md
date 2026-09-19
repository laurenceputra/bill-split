# Warm Ledger responsive audit matrix

Canonical audit widths are **320, 390, 768, 895, 896, and 1440px**. The
private shell keeps the mobile bottom navigation through 895px and switches to
the desktop top navigation and two-column group overview at 896px.

The refund/reimbursement matrix below remains the release checklist for the
dedicated online-only refund flow. The Warm Ledger states cover the newer
credit and shell surfaces without replacing those refund-specific checks.

## Refund/reimbursement states

Refunds are online-only ledger actions. Mobile DOM order keeps the common
expense-first path ahead of advanced standalone/custom allocation controls.

| Split Add control viewport | 320px narrow | 390px mobile | 430px mobile | 768px tablet | 895px tablet | 896px desktop | 1440px desktop |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Group header and contextual navigation | `+ Add expense` stays first; the transaction-type select is joined to it, and wrapped header actions do not overlap | `+ Add expense` stays first; the raised bottom-nav tile is contained; neighboring non-Add nav items are at least 44px wide and high | Compact labels remain on one row without clipping | Bottom navigation keeps the raised control ahead of Settings | Bottom navigation remains in use at the pre-desktop breakpoint | Desktop navigation switches on without changing destinations | Desktop control remains expense-first and alternatives open through the select control |
| Bottom-nav Add control shape and spacing | Raised purple tile fills a `clamp(100px, 25vw, 112px)` center column, extends about 8px above the bar, and reaches through the safe-area bottom via a decorative layer; every item uses the shared 20px icon canvas, 4px icon-label gap, and bottom content anchor, with the plus optically inset in that canvas and the Add label baseline matching neighboring labels; lower corners remain square, and the Add tile and primary segment are at least 44px high while the menu segment is at least 44px wide and high | Same raised tile geometry and shared two-row track; the safe-area extension does not stretch or shift the interactive controls, the 1px solid semi-transparent white shared divider remains visible in inactive and hover states and in both segment-specific keyboard-focus states, and inactive/active colors do not change dimensions | Raised tile remains centered and contained without clipping | Raised tile remains 112px wide and ahead of Settings | Raised tile remains 112px wide at the pre-desktop breakpoint | Desktop navigation switches on at 896px without changing destinations | Desktop pill shape is preserved; the desktop control remains expense-first |

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
visual inspection. The mobile Add tile uses a clipped rounded interactive
capsule with an inset focus treatment; its separate pseudo-element carries the
purple decoration through `safe-area-inset-bottom` while the controls remain in
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
| Record credit, loaded | Controls stack with the amount hero visible; no horizontal scroll | Form controls remain in DOM order: type, delivery, amount, application, allocations, note, submit | Verify select/field wrapping and no horizontal overflow | Verify disclosure and validation spacing at the breakpoint | Primary submit remains before secondary navigation | Primary submit remains before secondary navigation |
| Record credit, loading/error/offline | Loading status and inline error are announced; submit is disabled offline | Error text remains adjacent to the form | Error text remains adjacent to the form | Error text remains adjacent to the form | Error and retry remain content-sized | Error and retry remain content-sized |
| Credit detail, active | Applications and allocations stack; amount remains dominant | Application and allocation snapshots stack as rows; edit/delete follow detail | Verify rows wrap long IDs/notes | Verify deleted labels and restore affordance | Actions remain below the accounting explanation | Actions remain below the accounting explanation |
| Credit detail, deleted/restore | Restore is the only available mutation and is disabled offline | Tombstone copy remains visible | Tombstone copy remains visible | Restore remains a clear recovery action | Restore and error states remain readable without modal-only context | Restore and error states remain readable without modal-only context |
| Group home / invitations | Financial status leads each card; invitation actions remain reachable; empty-state actions stack without overlap | Empty and populated states retain separate, touch-sized creation actions; groups precede the spending snapshot | Cards use a denser two-column grid | Check card-to-overview boundary | Cards align amount columns and participant metadata | Cards align amount columns and participant metadata |
| Group overview | Balances precede transactions; schedules, people, and the grouped tools section disclose below | Same DOM order with touch-sized controls; Record credit and insights stay together after ledger content | Single-column financial reading order | Verify no premature desktop reflow | Balances lead a purposeful main/secondary layout; tools remain grouped after people | Two-column layout keeps money and status dominant |
| Expense and schedule forms | Amount hero, split controls, and payer sheet fit without zoom | Payer sheet is bottom anchored and targets remain 44px | Verify form grouping and recurring preview | Verify 895/896 transition without focus loss | Payer dialog is centered; amount remains first | Payer dialog and schedule preview remain readable |
| History and insights | Segmented tabs and filter disclosure stack | Transaction amounts align at row end | Chart/table fallback remains accessible | Verify boundary tab and search behavior | Desktop rows align like a ledger | Desktop rows align like a ledger |
| Management/settings | Dense groups remain single-column; deletion is last | People/invitations/defaults precede exports and destructive actions | Verify long names and disabled states | Verify boundary spacing | Compact administrative sections | Compact administrative sections |

Credit flows are online-only and preserve the existing mobile-first form shell.
The record-credit audit scenario uses the existing populated group fixture;
active and deleted credit detail states remain covered by focused unit and
integration fixtures until a browser fixture includes a persisted credit.
