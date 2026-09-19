# Refund/reimbursement responsive audit matrix

Refunds are online-only ledger actions. Mobile DOM order keeps the common
expense-first path ahead of advanced standalone/custom allocation controls.

| View/state | 390px mobile | 768px boundary | 1280px desktop |
| --- | --- | --- | --- |
| Add transaction chooser, global/group, trusted-offline cache | Cached groups or the cached group context still expose Expense first; connection-required actions remain visibly unavailable | Buttons wrap without changing order | Primary choices remain above management links |
| Record money back, loading/cached/offline/error | Loading, stale-cache, offline, conflict, and server-capacity messages stay beside the form; submit is unavailable offline | Picker and amount context do not overflow | Expense-first form and submit remain before advanced controls |
| Linked expense picker | Search/page controls and date/gross/refunded/remaining context remain readable; fully refunded rows are unavailable | Currency lock and additional-expense disclosure remain clear | Selected expense and currency context remain visible |
| Standalone/advanced allocations | Recipient and affected-member controls stack in task language; no silent recipient default | Custom allocation rows wrap safely | Advanced controls remain secondary to the preview |
| Expense detail | Gross, refunded, net, remaining, linked rows, and Add refund appear in reading order | Long notes and linked rows wrap | Add refund stays with the accounting summary |
| Refund detail active/deleted | Member names/You labels, linked expenses, money flow, balance effect, and collapsed audit remain reachable | Restore/conflict feedback is adjacent to the action | Audit is secondary to the plain-language accounting summary |
| History/filter states | Refund/reimbursement rows use the same filter and keyset list | Refund filter does not expose expense-only category controls | Rows preserve group and detail links |

This matrix is the release checklist, not a claim that screenshots have been
verified. Current automated coverage exercises routed loading state, form state
transitions, picker filtering, defaults, payload construction, and Add-route
cache contracts. Browser
responsive screenshots at 390px, 768px, and 1280px remain pending until the
Playwright/browser harness is run.
