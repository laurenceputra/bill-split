# BillSplit Design Language
## Warm Ledger: Plum & Sage

BillSplit records shared financial history; it does not process payments or move money. This language keeps that history calm, legible, and trustworthy across group, transaction, schedule, and people views.

## Principles

- **Financial hierarchy first.** Who owes whom, how much, and what is due come before metadata, management, and admin controls.
- **Warm, calm, practical.** Use plum for primary action and focus, sage for settled/positive outcomes, and restrained warm neutrals for the ledger surface.
- **Token-led implementation.** Components use semantic tokens, never hardcoded component colors. Prefer shared primitives over route-specific duplicates.
- **Progressive disclosure.** Show the next useful action first; move advanced tools, history, and destructive actions behind clear affordances.
- **Truthful states.** Distinguish loading, cached, offline, stale, pending, empty, and error states. Never imply a payment was processed.
- **No decoration that competes with money.** Do not use major gradients, glass effects, neon, crypto styling, or decorative imagery. Use only profile photos, with initials as the fallback.

## Semantic color tokens

Use these names in theme variables and component APIs. Do not invent near-duplicate colors.

### Brand and surfaces

| Token | Hex | Use |
|---|---|---|
| `primary` | `#6B4FD3` | Primary actions, links, focus emphasis |
| `primary-fg` | `#FFFFFF` | Foreground on primary controls |
| `primary-hover` | `#5F43C5` | Hover state |
| `primary-pressed` | `#5338B4` | Pressed/active state |
| `primary-focus-ring` | `#5338B4` | Keyboard focus ring |
| `primary-subtle` | `#EEE9FA` | Selected and soft emphasis backgrounds |
| `primary-subtle-hover` | `#E5DDF7` | Hover on subtle emphasis |
| `page` | `#F7F3FA` | App/page background |
| `surface` | `#FFFFFF` | Cards, fields, modal surfaces |
| `surface-elevated` | `#FFFFFF` | Elevated cards, dialogs, and sheets |
| `surface-secondary` | `#FBF9FC` | Nested or lower-emphasis surfaces |
| `border` | `#E7DFF0` | Default borders |
| `border-strong` | `#D8CDE4` | Emphasized boundaries |
| `divider` | `#ECE6F1` | Content separation |
| `text` | `#2F2540` | Primary text and amounts |
| `text-secondary` | `#746A84` | Supporting text |
| `text-tertiary` | `#6E647A` | Placeholder text, hints, and low-emphasis metadata |
| `text-disabled` | `#B8AFBF` | Disabled text and controls |
| `text-inverse` | `#FFFFFF` | Text on dark/primary surfaces |

### Financial and status semantics

| Token | Hex | Use |
|---|---|---|
| `positive-bg` | `#D8F0E1` | Settled/positive background |
| `positive-subtle` | `#EEF8F2` | Soft positive background |
| `positive-fg` | `#216B4A` | Settled/positive text and icon |
| `debt-bg` | `#F7D7D2` | Debt/amount-due background |
| `debt-subtle` | `#FCF0EE` | Soft debt background |
| `debt-fg` | `#9A403A` | Debt text and icon |
| `debt-strong` | `#A94741` | Strong debt emphasis |
| `warning-bg` | `#FDECC8` | Warning background |
| `warning-subtle` | `#FFF7E6` | Soft warning background |
| `warning-fg` | `#8A5B00` | Offline, stale, pending, and warning text |
| `neutral-bg` | `#F1EEF4` | Neutral status background |
| `neutral-fg` | `#746A84` | Neutral status text |

Color is never the sole indicator: pair it with text, an icon, position, or a status label.

## Typography

- Use **Inter** for all interface text and numeric content, with a system sans-serif fallback. Load the needed weights rather than substituting a display face.
- Establish a clear scale: compact labels and metadata, readable body text, strong page/card headings, and the largest weight/size reserved for balances and totals.
- Use weight and size for hierarchy; avoid all-caps paragraphs and excessive bolding.
- Financial amounts use `font-variant-numeric: tabular-nums` (or the equivalent numeric font feature) so columns align. Keep currency code/symbol and sign unambiguous, and do not silently convert currencies.
- Labels remain visible beside fields. Never use floating labels; helper text belongs below the field.

## Geometry, spacing, radii, and shadows

- Use an 8px-based spacing system; retain 4px for micro spacing. The shared scale is 4, 8, 12, 16, 20, 24, 32, and 48px. Use 16px page padding on mobile and 24–32px on desktop; keep related content tight and give major sections more breathing room.
- Cards and controls use generous touchable padding and predictable alignment. Prefer one content column on small screens and a constrained, readable content width on desktop.
- Use small radii for fields and pills, medium radii for cards, and larger radii only for prominent containers or sheets. Keep the radius vocabulary small and shared.
- Shadows are soft, warm, and sparing: use a subtle elevation for cards or modal layers, never a dark or dramatic glow. Borders should carry most of the structure.
- Minimum interactive target is **44px** in both dimensions, including icon-only controls.

## Reusable components

Build and compose these primitives instead of creating page-specific versions:

`AppShell`, `MobileBottomNav`, `DesktopTopNav`, `PageHeader`, `Section`, `Card`, `LedgerList`, `LedgerRow`, `BalanceCard`, `GroupCard`, `TransactionRow`, `SettlementRow`, `PersonRow`, `Avatar`, `AvatarStack`, `StatusPill`, `Notice`, `Button`, `IconButton`, `Input`, `Select`, `AmountInput`, `FormField`, `SectionHeader`, `Disclosure`, `Modal`, `BottomSheet`, `ConfirmationDialog`, `Skeleton`, and `EmptyState`. Foundational `Stack`, `Inline`, `Divider`, `Link`, `Toast`, and `Icon` primitives may support them.

## Page, section, and ledger hierarchy

The visual hierarchy is intentionally lighter than the semantic hierarchy:

```text
Page (route view)
└── Section (a semantic landmark and flow group)
    └── Ledger group (a related set of financial rows)
        └── Card or ledger row (the painted decision surface, when needed)
```

Semantic elements are not automatically painted cards. A `section` identifies a
topic or landmark and supplies grouping and spacing; it does not receive a
border, fill, radius, or shadow merely because it is a `section`. A `.list` is a
structural ledger-list container, and a `.row` is a transparent ledger-row
with dividers and interaction feedback. Use the explicit `Card`/`.card` or
`.surface` role only when a contained surface helps a user understand one
decision, one primary financial anchor, or one focused task.

### Surface roles

- **Card**: a contained, scannable unit such as a Home group card, a primary
  balance anchor, a focused form surface, a modal, an invitation state, or an
  empty state. It may use the surface token, border, and restrained elevation.
- **Section**: a semantic topic boundary with structural spacing. It stays
  borderless and transparent unless it has an explicit route or component
  surface role.
- **LedgerList**: the transparent list container for related transactions,
  balances, activity, schedules, people, or history rows. It uses alignment,
  spacing, and dividers rather than a nested card treatment.
- **LedgerRow**: one ledger item. Rows keep amounts tabular and aligned, have
  a minimum touch target when interactive, and expose hover and visible
  keyboard focus without requiring a painted parent.

Do not add a wrapper only to supply another border or padding layer. Avoid
nested painted surfaces; a card may contain a ledger list, but its individual
rows should normally remain transparent. If a contained surface cannot explain
what decision, status, or financial anchor it contains, flatten it into the
nearest section or ledger group.

### Route surface rules

- **Home** keeps group cards as the primary navigation surfaces. The spending
  snapshot is a borderless section with aligned, divider-separated currency
  rows; its outer section and metric rows are not cards. Invitations and the
  no-groups empty state remain contained because they need distinct status and
  recovery treatment.
- **Group Overview** uses one primary balances anchor card. Balance entries
  inside it, recent transactions, schedules, people, tools, and compact
  spending are borderless sections or ledger rows. The reading order remains
  balances → transactions → schedules → people → tools on mobile, with the
  existing desktop two-column arrangement preserved.
- **History** keeps the group filter, tabs, disclosures, and controls in flow.
  Transaction and activity results are transparent divider-separated ledger
  rows; the history page itself is not a card.
- **Insights** keeps the page and filter controls in flow. Only intentional
  summary and chart modules may be contained, and they must not introduce
  painted cards inside painted cards. The exact-value table remains available
  to assistive technology and the existing loading, cached, offline, empty,
  and error states remain explicit.
- **Forms** use one explicit focused form surface when the task benefits from
  containment. Fieldsets, amount anchors, disclosures, validation messages,
  and modal/bottom-sheet content may be visually distinct, but generic
  sections and ledger rows do not become extra cards.
- **Management and settings** may retain contained administrative sections so
  destructive, connection-dependent, invitation, export, and account actions
  do not visually merge. Their member and activity collections still use
  ledger rows and avoid cards nested inside those sections.

### Card-density review criterion

For every changed route, count visible painted ancestors from the page surface
to each meaningful content unit. A normal content path should have at most one
intentional painted container; a primary financial anchor or modal may have a
second level for its contained rows or focused controls. Any additional border,
fill, radius, or shadow must be justified by a distinct decision, state, or
interaction. Review this at 320, 390, 768, 895, 896, and 1440px, including
loading, cached, offline, empty, error, and disclosure states.

## Component rules

### Cards

Cards group one decision or related ledger information. Use surface, border, and restrained elevation; do not stack unnecessary cards inside cards. Put the title and primary amount/action first, supporting metadata second, and tools last. A card must still communicate its state without relying on hover. Prefer a section or ledger list when grouping alone is sufficient.

### Buttons and links

Use a filled primary button for the main task, secondary/outline treatment for alternatives, and a quiet text or icon action for low-risk tools. Label actions with verbs and specific outcomes (for example, “Add expense” or “Mark as settled”). Preserve 44px targets, visible focus, disabled semantics, hover and pressed tokens, and a loading state that prevents duplicate submission. Destructive actions are never styled as the primary path by accident.

### Forms

Use visible, associated labels, logical reading order, concise helper text, and inline errors adjacent to the invalid field. Preserve entered values on recoverable errors. Group related fields with `fieldset`/`legend` where appropriate, expose required and optional status, and make submit state explicit. On mobile/touch layouts, all text-entry controls (`input`, `select`, and `textarea`) must have a computed `font-size` of at least 16px to prevent automatic focus zoom in iOS Safari; placeholder text and visually scaled transforms do not satisfy this requirement—the control's computed `font-size` is what matters.

### Amount input

Show currency context, accept only the intended numeric format, and format with tabular numerals without hiding precision or sign. Keep the label visible; do not auto-convert currencies. Validate negative/zero values and split rules with plain-language messages. On mobile, use an input mode suited to numeric entry while retaining an accessible text label.

### Avatars

Use profile photos only when supplied by the person; otherwise show deterministic initials with an accessible name. Do not use decorative illustrations or arbitrary stock imagery. Avatar groups cap visible items and provide an explicit overflow count/list.

### Icons

Icons clarify a nearby label or familiar navigation item; they do not replace essential text. Use one consistent icon set, matching optical size and stroke weight. Decorative icons are hidden from assistive technology; icon-only buttons require an accessible name and 44px target.

## Navigation and Responsive Layout

- Design and verify at **390px** mobile and **1440px** desktop widths; support a minimum width of **320px** without horizontal scrolling.
- Treat **768px**, **895px**, and **896px** as explicit responsive boundaries. At 768px and below, prioritize a single-column, touch-first layout. At 895px, test the boundary behavior; at 896px and above, allow desktop navigation and multi-column arrangements where useful.
- Mobile uses a persistent four-item bottom navigation: **Groups**, **History**, **Add**, and **Settings**. Keep labels visible, make **Add** centered and prominent, respect safe-area insets, and do not let content hide behind it.
- Desktop uses a top navigation containing **BillSplit**, **Groups**, **History**, **Add expense**, **Settings**, connection state, relevant install/pending/update controls, and the user avatar. Frequent tasks appear before admin tools.
- Preserve mobile DOM order; responsive CSS must not create a misleading reading or focus order. In **Group Overview**, the order is: **balances → transactions → schedules → people → tools**. Tools may move visually but not ahead of financial content in the DOM.
- Use semantic landmarks (`header`, `nav`, `main`, `section`, `footer`) and progressive disclosure for secondary controls.

## Financial Content

- Lead with the group balance: net position, who owes whom, and the next useful action. Make payer, participants, amount, currency, date, and settlement state scannable.
- Keep totals and owed amounts visually dominant; use tabular numerals and consistent sign conventions. Never imply that recording, settling, or reminding is a payment transaction.
- Explain split methods and rounding where they affect the result. Preserve a shared history of edits and settlements; make dates and actors available for auditability.
- Use realistic copy that answers “what happened, who is affected, and what can I do next?” Avoid unexplained accounting jargon.

## States and Feedback

- Model loading, cached, offline, stale, pending, empty, success, and error states as distinct component states. Skeletons preserve layout; errors offer a recovery action; empty states explain the first useful action.
- Offline behavior is calm: retain readable cached history, show a compact warning status (not a blocking alarm), identify unsynced/pending changes, and explain what will happen when connectivity returns. Do not claim sync or settlement before confirmation.
- Use status pills with a short text label and, when useful, an icon. The warning palette is used for offline, stale, and pending states; positive is for confirmed settled/healthy states; debt is for money owed; neutral is for informational state.
- Toasts confirm low-risk, completed changes and disappear without trapping focus. Persistent or consequential feedback belongs in an inline banner or page region with an accessible live update.

## Modals and Destructive Actions

- Prefer an inline flow or drawer for simple, frequent work; use a modal for a focused decision that cannot be completed safely in context. Keep the title, consequence, primary action, and cancel action clear.
- Modal focus moves in, is trapped while open, and returns to the invoking control. Escape closes only when safe; preserve entered values when possible.
- Confirm destructive actions with specific language, show what will be removed or changed, and require an explicit verb (for example, “Delete expense”). Place cancel first in the visual/DOM action group where appropriate and never hide the only recovery path.
- Do not use destructive styling for ordinary navigation or reversible edits. State whether deletion affects shared history and whether an undo is available.

## Accessibility and Motion

- Meet WCAG AA contrast for text and controls, provide visible keyboard focus, support keyboard and screen-reader operation, and use semantic HTML before ARIA.
- Announce validation, save, sync, and error changes without stealing focus. Ensure names, roles, values, and relationships are exposed for custom controls.
- Respect `prefers-reduced-motion`; default to short, purposeful transitions for feedback and navigation. Never make financial information depend on animation, parallax, or motion.
- Test at narrow mobile, breakpoint boundaries, and desktop with zoom/reflow, touch, keyboard, screen reader, and long names/amounts.

## Content

- Write direct, warm, specific copy. Prefer “Alex owes you $24.00” to vague labels such as “Balance update.”
- Use sentence case, active verbs, and consistent terms: expense, split, balance, settle, schedule, person, and group.
- Explain offline, stale, pending, rounding, and failure states in plain language. Never promise payment processing, bank movement, or automatic currency conversion.
- Dates, currencies, signs, and names must remain unambiguous in narrow layouts; truncate only with an accessible full value.

## Review Checklist and priority ordering

Review in this order:

1. **Financial truth:** balances, participants, amounts, currency, split math, history, and no payment-processing implication.
2. **Primary task:** the frequent action is first, labeled, enabled only when valid, and usable offline/error-safe.
3. **Information hierarchy:** financial content precedes management/admin tools; Group Overview follows balances → transactions → schedules → people → tools.
4. **Responsive behavior:** verify 320 minimum, 390 mobile, 768/895/896 boundaries, and 1440 desktop; confirm mobile bottom nav and desktop top nav.
5. **Accessibility:** 44px targets, visible labels, keyboard/focus behavior, contrast, semantics, announcements, and color-plus-text status cues.
6. **States and recovery:** loading, cached, offline, stale, pending, empty, success, error, modal, and destructive flows are explicit and recoverable.
7. **Card density:** semantic sections remain structural, ledger lists use transparent rows, and every painted surface has an explicit role with no unnecessary nested surface.
8. **System consistency:** semantic tokens only, shared primitives reused, restrained geometry/shadows, no forbidden visual treatments, and no route-specific duplicate components.
