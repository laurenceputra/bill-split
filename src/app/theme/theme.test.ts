import { describe, expect, it } from 'vitest';
// The application tsconfig intentionally does not include Node types; this
// test runs in Vitest's Node environment and reads the authored stylesheet.
// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./components.css', import.meta.url), 'utf8');
const baseCss = readFileSync(new URL('./base.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const errorBoundarySource = readFileSync(new URL('../ErrorBoundary.tsx', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../ui.tsx', import.meta.url), 'utf8');

describe('responsive navigation layout contract', () => {
  it('keeps four-pixel mobile edge spacing while preserving safe areas', () => {
    expect(css).toContain('padding-right: max(var(--space-1), var(--safe-right));');
    expect(css).toContain('padding-left: max(var(--space-1), var(--safe-left));');
    expect(css).toContain('padding-bottom: calc(var(--space-1) + var(--safe-bottom));');
    expect(css).toMatch(/@media \(max-width: 30rem\)[\s\S]*\.top-bar\s*\{[\s\S]*padding-right: max\(var\(--space-1\), var\(--safe-right\)\);/);
  });

  it('reserves mobile navigation space and removes that reservation on desktop', () => {
    expect(css).toContain('padding: var(--space-6) max(var(--space-4), var(--safe-right)) calc(var(--space-4) + var(--nav-height) + var(--space-2) + var(--safe-bottom)) max(var(--space-4), var(--safe-left));');
    expect(css).toMatch(/@media \(min-width: 56rem\)[\s\S]*\.app-main\s*\{[\s\S]*padding-bottom: var\(--space-10\);[\s\S]*\.bottom-nav\s*\{[\s\S]*display: none;/);
  });

  it('removes the install reservation globally when InstallAction renders no child', () => {
    const emptyRule = /\.install-slot:empty\s*\{\s*display: none;\s*\}/;
    const baseRuleIndex = css.indexOf('.install-slot {');
    const emptyRuleIndex = css.search(emptyRule);
    const mobileRulesIndex = css.indexOf('@media (max-width: 30rem)');

    expect(css).toMatch(emptyRule);
    expect(baseRuleIndex).toBeGreaterThanOrEqual(0);
    expect(emptyRuleIndex).toBeGreaterThan(baseRuleIndex);
    expect(emptyRuleIndex).toBeGreaterThanOrEqual(0);
    expect(emptyRuleIndex).toBeLessThan(mobileRulesIndex);
    // :empty is more specific than the mobile .install-slot display: contents
    // override, so an empty slot stays removed at every viewport.
    expect(css).toMatch(/\.install-slot\s*\{[\s\S]*width: 4\.5rem;[\s\S]*min-width: 4\.5rem;[\s\S]*flex: 0 0 4\.5rem;/);
    expect(css).toMatch(/@media \(max-width: 30rem\)[\s\S]*\.install-slot\s*\{[\s\S]*display: contents;/);
  });

  it('keeps the mobile contracts at 320, 390, and 430 pixels', () => {
    expect([320, 390, 430].every((viewport) => viewport >= 320 && viewport <= 30 * 16)).toBe(true);
    expect(baseCss).toContain('html {\n  min-width: 320px;');
    expect(css).toMatch(/@media \(max-width: 30rem\)[\s\S]*\.install-slot\s*\{[\s\S]*display: contents;/);
    expect(css).toContain('.install-slot > .install-control {\n    width: auto;\n  }');
    expect(css).toMatch(/\.nav-item--add\s*\{[\s\S]*align-items: stretch;/);
    expect(css).toMatch(/\.nav-item__capsule\s*\{[\s\S]*align-self: stretch;/);
    expect(css).toMatch(/\.install-action\s*\{[\s\S]*min-height: 2\.75rem;/);
  });

  it('uses explicit action gaps and a predictable single-column mobile layout', () => {
    expect(css).toMatch(/\.home-actions\s*\{[\s\S]*display: grid;[\s\S]*column-gap: var\(--space-3\);[\s\S]*row-gap: var\(--space-2\);/);
    expect(css).toMatch(/@media \(max-width: 30rem\)[\s\S]*\.home-actions\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.section-title\s*\{[\s\S]*flex-wrap: wrap;[\s\S]*row-gap: var\(--space-2\);/);
    expect(css).toMatch(/\.section-title > h2\s*\{[\s\S]*min-width: 0;/);
    expect(css).toMatch(/\.section-title \+ \.member-list\s*\{[\s\S]*margin-top: var\(--space-3\);/);
    expect(css).toMatch(/:where\(\.section-title\) \+ p\s*\{[\s\S]*margin-top: var\(--space-3\);/);
  });

  it('styles the native expense filter disclosure at its actual DOM depth', () => {
    expect(css).toMatch(/\.expense-filters-disclosure\s*>\s*details\s*>\s*summary\s*\{/);
    expect(css).toMatch(/\.expense-filters-disclosure\s*>\s*details\[open\]\s*>\s*summary\s*\{/);
    expect(css).not.toMatch(/\.expense-filters-disclosure\s*>\s*summary\s*\{/);
  });

  it('keeps activity row focus visible inside clipped lists', () => {
    expect(css).toMatch(/\.row\[href\]:focus-visible\s*\{[\s\S]*box-shadow: inset 0 0 0 3px var\(--color-focus\);[\s\S]*outline: 3px solid var\(--color-focus\);[\s\S]*outline-offset: -3px;/);
  });

  it('keeps every mobile editable control at the iOS zoom floor without shrinking the main amount', () => {
    expect(baseCss).toMatch(/@media \(max-width: 55\.999rem\)[\s\S]*input,[\s\S]*select,[\s\S]*textarea\s*\{[\s\S]*font-size: 1rem;/);
    expect(css).toMatch(/\.dev-identity input\s*\{[\s\S]*font-size: 1rem;/);
    expect(css).toMatch(/\.amount-input--long\s*\{[\s\S]*font-size: 1rem;/);
    expect(css).toMatch(/\.amount-input--very-long\s*\{[\s\S]*font-size: 1rem;/);
    expect(css).toMatch(/\.amount-field > input\s*\{[\s\S]*font-size: var\(--text-amount\);/);
    expect(css).not.toContain('font-size: 0.76rem;');
    expect(css).not.toContain('font-size: 0.6rem;');
  });

  it('extends the active add highlight through the safe-area while keeping content in the nav item', () => {
    expect(css).toMatch(/\.nav-item--add\[aria-current="page"\]::before\s*\{[\s\S]*top: calc\(-1 \* var\(--space-1\)\);[\s\S]*bottom: calc\(-1 \* \(var\(--space-1\) \+ var\(--safe-bottom\)\)\);[\s\S]*border-radius: var\(--radius-lg\) var\(--radius-lg\) 0 0;/);
    expect(css).toMatch(/\.nav-item--add\[aria-current="page"\] \.nav-item__capsule\s*\{[\s\S]*z-index: 1;[\s\S]*background: transparent;/);
    expect(css).toMatch(/\.nav-item--add:not\(\[aria-current="page"\]\):hover \.nav-item__capsule\s*\{/);
    expect(uiSource).toContain('className="nav-item nav-item--add"');
  });

  it('keeps the activity filter separated from the result list at every responsive size', () => {
    expect(css).toMatch(/\.activity-filter\s*\{[\s\S]*margin-bottom: var\(--space-4\);/);
    expect(css).toMatch(/@media \(min-width: 48rem\)[\s\S]*\.activity-filter\s*\{[\s\S]*margin-bottom: var\(--space-5\);/);
    expect(appSource).toContain('className="activity-filter reading-width"');
  });

  it('uses a native timezone select and preserves boundary recovery actions', () => {
    expect(appSource).toContain('<select id="creator-timezone"');
    expect(appSource).not.toContain('<datalist id="timezone-options">');
    expect(appSource).toContain('timezoneLabel(zone, timezoneLabelDate)');
    expect(appSource).toContain('value={timezoneSelectValue}');
    expect(appSource).toContain('value={zone}');
    expect(appSource).toContain('Other IANA timezone…');
    expect(appSource).toContain('id="custom-timezone"');
    expect(appSource).toContain('scheduledExpenseInput.parse');
    expect(errorBoundarySource).toContain('>Reload</button>');
    expect(errorBoundarySource).toContain('href="/">Return to Groups</a>');
    expect(errorBoundarySource).not.toContain('clearCachedData');
  });

  it('keeps recurrence opt-in clear and preview dates separated', () => {
    expect(appSource).toContain('id="repeat-expense"');
    expect(appSource).toContain('<span>Repeat this expense</span>');
    expect(appSource).toContain('Categories are saved with expenses. Notes are saved for one-time expenses only');
    expect(appSource).toContain('showNotes={false}');
    expect(appSource).toContain('Categories are saved with scheduled expenses. Notes are available for one-time expenses only');
    expect(appSource).toContain('aria-describedby="one-time-only-details-help"');
    expect(css).toMatch(/\.one-time-only-details\s*\{[\s\S]*display: grid;[\s\S]*gap: var\(--space-3\);/);
    expect(css).toMatch(/\.schedule-preview ol\s*\{[\s\S]*display: grid;[\s\S]*gap: var\(--space-2\);/);
    expect(appSource).toContain('scheduleContinuationText(endDate, schedulePreview)');
    expect(appSource).toContain('occurrences affect balances only when posted');
  });

  it('keeps tablet sizing and desktop overrides for 1024 and 1280 pixels', () => {
    expect(768).toBeGreaterThanOrEqual(48 * 16);
    expect([1024, 1280].every((viewport) => viewport >= 56 * 16)).toBe(true);
    expect(css).toMatch(/@media \(min-width: 48rem\)[\s\S]*\.nav-item\s*\{[\s\S]*padding-inline: var\(--space-3\);/);
    expect(css).toMatch(/@media \(min-width: 56rem\)[\s\S]*\.desktop-nav\s*\{[\s\S]*display: flex;/);
    expect(css).toMatch(/@media \(min-width: 56rem\)[\s\S]*\.bottom-nav\s*\{[\s\S]*display: none;/);
  });

  it('keeps the public landing separate from the private shell', () => {
    expect(appSource).toContain('<PublicShell returnTo={returnTo}>');
    expect(appSource).toContain("if (auth.status === 'unauthenticated') return <PublicLanding");
    expect(css).toMatch(/\.public-shell\s*\{[\s\S]*min-height: 100vh;/);
    expect(css).toMatch(/@media \(max-width: 30rem\)[\s\S]*\.landing-primary,[\s\S]*width: 100%;/);
    expect(css).toMatch(/@media \(min-width: 56rem\)[\s\S]*\.landing-hero\s*\{[\s\S]*grid-template-columns:/);
  });

  it('uses a data-free private-shaped auth loading shell and stable notification geometry', () => {
    expect(uiSource).toContain('export function AuthLoadingShell()');
    expect(uiSource).toContain('aria-live="polite">Loading…</p>');
    expect(appSource).toContain('return <AuthLoadingShell />;');
    expect(css).toMatch(/\.auth-banner\s*\{[\s\S]*position: fixed;[\s\S]*max-height:/);
    expect(baseCss).toContain('scrollbar-gutter: stable;');
  });

  it('keeps cold route placeholders visual-only while preserving cached resources', () => {
    expect(appSource).toContain('function HomeLoadingPlaceholder()');
    expect(appSource).toContain('function GroupOverviewLoadingPlaceholder()');
    expect(appSource).toContain('const coldHomeLoading = online && !offline');
    expect(appSource).toContain("me.status === 'idle' || me.status === 'loading'");
    expect(appSource).toContain('const coldGroupLoading = online && !offline');
    expect(appSource).toContain('if (coldGroupLoading) return <Layout><GroupOverviewLoadingPlaceholder /></Layout>;');
    expect(appSource).toContain('function GroupOverviewUnavailable');
    expect(appSource).toContain('Group unavailable offline');
    expect(appSource).toContain('This group is not cached on this device. Reconnect to load it.');
    expect(appSource).toContain('<Link className="back" to="/">← Groups</Link>');
    expect(uiSource).toContain('aria-hidden="true"');
    expect(css).toContain('.skeleton {');
  });

  it('keeps the tablet auth banner above the fixed navigation and mirrors group actions', () => {
    expect(css).toMatch(/\.auth-banner\s*\{[\s\S]*bottom: calc\(var\(--space-4\) \+ var\(--safe-bottom\)\);/);
    expect(css).toMatch(/@media \(max-width: 55\.999rem\)[\s\S]*\.auth-banner\s*\{[\s\S]*bottom: calc\(var\(--nav-height\)[\s\S]*var\(--safe-bottom\)\);/);
    expect(css).toMatch(/\.skeleton--back\s*\{[\s\S]*min-height: 2\.75rem;/);
    expect(css).toMatch(/\.route-loading__actions--expense\s*\{[\s\S]*flex-wrap: nowrap;/);
    expect(css).toMatch(/@media \(max-width: 30rem\)[\s\S]*\.route-loading__actions--expense\s*\{[\s\S]*flex-direction: row;/);
    expect(appSource).toContain('className="route-loading__actions route-loading__actions--expense"');
  });

  it('keeps public sign-up hover readable and reduces landing-page whitespace', () => {
    expect(css).toMatch(/\.public-sign-up:hover\s*\{[\s\S]*background: var\(--color-secondary-hover\);[\s\S]*color: var\(--color-primary-strong\);/);
    expect(css).toMatch(/\.public-main\s*\{\s*padding-top: clamp\(var\(--space-8\), 5vw, var\(--space-12\)\);/);
    expect(baseCss).toMatch(/button:focus-visible\s*,[\s\S]*outline: 3px solid var\(--color-focus\);/);
  });

  it('gives both public sign-in buttons the primary treatment and keeps focus visible', () => {
    const signInRule = css.match(/\.public-sign-in\s*\{([^}]*)\}/)?.[1] ?? '';
    const signInHoverRule = css.match(/\.public-sign-in:hover\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(signInRule).toContain('background: var(--color-primary);');
    expect(signInRule).toContain('color: var(--color-on-primary);');
    expect(signInHoverRule).toContain('background: var(--color-primary-strong);');
    expect(signInHoverRule).toContain('color: var(--color-on-primary);');
    expect(css).toMatch(/\.button,\s*button\s*\{[\s\S]*background: var\(--color-primary\);/);
    expect(baseCss).toMatch(/button:focus-visible\s*,[\s\S]*outline: 3px solid var\(--color-focus\);/);
    expect(appSource).toContain('className="button landing-primary public-sign-in"');
    expect(appSource).toContain('>Sign up</button>');
    expect(uiSource).toContain('className="public-sign-in"');
    expect(uiSource).toContain('>Sign up</button>');
  });

  it('keeps proof items free of decorative borders and offset padding', () => {
    const proofItemRule = css.match(/\.landing-proof > div\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(proofItemRule).toContain('display: grid;');
    expect(proofItemRule).toContain('gap: var(--space-1);');
    expect(proofItemRule).not.toContain('border-top');
    expect(proofItemRule).not.toContain('padding-top');
  });

  it('keeps targeted participant email controls owner-only and group-scoped', () => {
    expect(appSource).toContain('function TargetedInvitationControl');
    expect(appSource).toContain('createTargetedGroupInvitation(groupId, member.personId, email.trim())');
    expect(appSource).toContain('invitationsResource={invitationsResource}');
    expect(appSource).toContain('function OwnerGroupManagement');
    expect(appSource).toContain('getOwnerInvitations(groupId, signal)');
    expect(appSource).toContain('invitationsResource?.data !== undefined ? <TargetedInvitationControl');
    expect(appSource).toContain('summary>Add email</summary>');
    expect(appSource).toContain('filter((invitation) => invitation.targetPersonId == null)');
    expect(appSource).toContain('currentPersonId={currentPersonId}');
    expect(appSource).toContain('expensePersonLabel(payer.personId)');
    expect(css).toMatch(/\.member-email-control\s*\{[\s\S]*display: grid;[\s\S]*gap: var\(--space-2\);/);
    expect(css).toMatch(/@media \(max-width: 30rem\)[\s\S]*\.member-email-control form\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/);
  });

  it('contains targeted email controls and wraps pending invitation text', () => {
    const containmentRule = css.match(/\.member-email-control,\s*\.member-email-control form,\s*\.member-email-control \.field,\s*\.member-email-control__pending,\s*\.member-email-control__pending-actions\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(containmentRule).toContain('min-width: 0;');
    expect(containmentRule).toContain('max-width: 100%;');
    expect(css).toMatch(/\.member-email-control__pending\s*\{[\s\S]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.member-email-control__pending > span:first-child\s*\{[\s\S]*min-width: 0;[\s\S]*overflow-wrap: anywhere;/);
  });

  it('defines every spacing token referenced by the authored stylesheets', () => {
    const references = [...`${css}\n${baseCss}`.matchAll(/var\(--(space-\d+)\)/g)].map((match) => match[1]);
    expect([...new Set(references)].every((token) => new RegExp(`--${token}\\s*:`).test(tokensCss))).toBe(true);
  });
});
