# Refund/reimbursement responsive audit matrix

Refunds are online-only ledger actions. Mobile DOM order keeps the common
expense-first path ahead of advanced standalone/custom allocation controls.

| Split Add control viewport | 320px narrow | 390px mobile | 430px mobile | 768px tablet | 895px tablet | 896px desktop | 1440px desktop |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Group header and contextual navigation | `+ Add expense` stays first; the transaction-type select is joined to it, the compact rounded-rectangle control remains bounded, and wrapped header actions do not overlap | `+ Add expense` stays first; the compact rounded-rectangle control joins the transaction-type select and each segment is at least 44px | Compact labels remain on one row without clipping | Bottom navigation keeps the control ahead of Settings | Bottom navigation remains in use at the pre-desktop breakpoint | Desktop navigation switches on without changing destinations | Desktop control remains expense-first and alternatives open through the select control |
| Bottom-nav Add control shape and spacing | Rounded rectangle; primary side uses 8px inline padding; both segments remain at least 44px | Rounded rectangle; primary side uses 8px inline padding; both segments remain at least 44px | Rounded rectangle; primary side uses 8px inline padding; both segments remain at least 44px | Rounded rectangle; primary side uses 8px inline padding; both segments remain at least 44px | Rounded rectangle; primary side uses 8px inline padding; both segments remain at least 44px | Desktop pill shape is preserved; the desktop control remains expense-first | Desktop pill shape is preserved; the desktop control remains expense-first |

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
visual inspection.
