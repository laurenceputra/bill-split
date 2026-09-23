import { describe, expect, it } from 'vitest';
// The application tsconfig intentionally does not include Node types.
// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';

const themeDir = new URL('./', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, themeDir), 'utf8');
const files = ['tokens.css', 'base.css', 'foundations.css', 'shell.css', 'primitives.css', 'home-creation.css', 'group-management.css', 'group-overview.css', 'transaction-forms.css', 'history-insights.css', 'settings.css', 'responsive.css'];
const css = files.map(read).join('\n');
const theme = read('theme.css');
const tokens = read('tokens.css');
const base = read('base.css');
const foundations = read('foundations.css');
const shell = read('shell.css');
const responsive = read('responsive.css');
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const errorBoundarySource = readFileSync(new URL('../ErrorBoundary.tsx', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../ui.tsx', import.meta.url), 'utf8');
const auditSource = readFileSync(new URL('../../../tests/e2e/audit.spec.ts', import.meta.url), 'utf8');

const tokenValue = (name: string): string => {
  const value = tokens.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(#[0-9A-Fa-f]{6}|var\\(--[^)]+\\))`))?.[1] ?? '';
  const alias = value.match(/^var\((--[^)]+)\)$/)?.[1];
  return alias ? tokenValue(alias) : value;
};
const relativeLuminance = (hex: string) => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255).map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrastRatio = (foreground: string, background: string) => {
  const [lower, higher] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => a - b);
  return (higher + 0.05) / (lower + 0.05);
};

describe('Warm Ledger visual system', () => {
  it('loads latin-only Inter weights that are actually used', () => {
    for (const weight of [400, 600, 700]) expect(theme).toContain(`@fontsource/inter/latin-${weight}.css`);
    expect(theme).not.toContain('@fontsource/inter/500.css');
    expect(theme).not.toContain('@fontsource/inter/latin-500.css');
    expect(theme).not.toMatch(/@fontsource\/inter\/(?:400|600|700)\.css/);
    expect(theme).toContain("@import './tokens.css';");
    expect(theme).toContain("@import './responsive.css';");
    expect(tokens).toContain('--font-body: Inter,');
    expect(css).not.toMatch(/font-weight:\s*900/);
  });

  it('keeps every semantic foreground/background pair at WCAG AA contrast', () => {
    const pairs: Array<[string, string]> = [
      ['--color-primary-fg', '--color-primary'],
      ['--color-primary-fg', '--color-primary-hover'],
      ['--color-primary-fg', '--color-primary-pressed'],
      ['--color-text-inverse', '--color-primary'],
      ['--color-primary-hover', '--color-primary-subtle'],
      ['--color-primary-hover', '--color-primary-subtle-hover'],
      ['--color-text', '--color-page'],
      ['--color-text', '--color-surface'],
      ['--color-text-secondary', '--color-page'],
      ['--color-text-secondary', '--color-surface'],
      ['--color-text-secondary', '--color-surface-secondary'],
      ['--color-text-tertiary', '--color-page'],
      ['--color-text-tertiary', '--color-surface'],
      ['--color-text-tertiary', '--color-surface-secondary'],
      ['--color-control-placeholder', '--color-control-bg'],
      ['--color-control-invalid-border', '--color-control-invalid-bg'],
      ['--color-positive-fg', '--color-positive-bg'],
      ['--color-positive-fg', '--color-positive-subtle'],
      ['--color-positive-fg', '--color-page'],
      ['--color-positive-fg', '--color-surface'],
      ['--color-debt-fg', '--color-debt-bg'],
      ['--color-debt-fg', '--color-debt-subtle'],
      ['--color-debt-fg', '--color-page'],
      ['--color-debt-fg', '--color-surface'],
      ['--color-debt-strong', '--color-debt-bg'],
      ['--color-debt-strong', '--color-debt-subtle'],
      ['--color-warning-fg', '--color-warning-bg'],
      ['--color-warning-fg', '--color-warning-subtle'],
      ['--color-warning-fg', '--color-page'],
      ['--color-neutral-fg', '--color-neutral-bg'],
      ['--color-neutral-fg', '--color-page'],
      ['--color-neutral-fg', '--color-surface'],
    ];
    for (const [foregroundName, backgroundName] of pairs) {
      const foreground = tokenValue(foregroundName);
      const background = tokenValue(backgroundName);
      expect(foreground, `${foregroundName} must be an authored hex token`).toMatch(/^#/);
      expect(background, `${backgroundName} must be an authored hex token`).toMatch(/^#/);
      expect(contrastRatio(foreground, background), `${foregroundName} on ${backgroundName}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(tokenValue('--color-primary-focus-ring'), tokenValue('--color-page'))).toBeGreaterThanOrEqual(3);
    expect(base).toContain('input::placeholder {\n  color: var(--color-text-tertiary);');
    expect(css).toMatch(/\.error\s*\{[\s\S]*background: var\(--color-debt-bg\);[\s\S]*color: var\(--color-debt-fg\);/);
    expect(css).toMatch(/\.ui-resource-state--error\s*\{[\s\S]*background: var\(--color-debt-subtle\);[\s\S]*color: var\(--color-debt-fg\);/);
  });

  it('keeps native control boundaries visible on their adjacent surfaces', () => {
    for (const background of ['--color-control-bg', '--color-surface', '--color-page', '--color-surface-secondary']) {
      expect(contrastRatio(tokenValue('--color-control-border'), tokenValue(background)), `control border on ${background}`).toBeGreaterThanOrEqual(3);
    }
    expect(base).toMatch(/input,\s*select,\s*textarea\s*\{[^}]*border: 1px solid var\(--color-control-border\);/);
    expect(base).toContain('border-color: var(--color-primary);');
  });

  it('uses semantic tokens without old authored aliases or caret colors', () => {
    expect(tokens).toContain('--color-page: #F7F3FA;');
    expect(tokens).toContain('--color-primary: #6B4FD3;');
    expect(tokens).toContain('--color-positive-fg:');
    expect(tokens).toContain('--color-debt-fg:');
    expect(css).not.toMatch(/var\(--color-(ink|canvas|mint|coral|focus|on-primary|surface-muted|primary-strong|primary-soft|topbar|nav-surface|overlay|secondary-hover|danger-border|danger-hover)\)/);
    expect(tokens).not.toMatch(/--color-(ink|canvas|mint|coral|focus|on-primary|surface-muted|primary-strong|primary-soft|topbar|nav-surface|overlay|secondary-hover|danger-border|danger-hover)\s*:/);
    expect(base).toContain("stroke='%23746A84'");
    expect(base).not.toContain('%23756A67');
  });

  it('owns the 895/896 responsive boundary in one responsive layer', () => {
    expect(foundations).toContain('--breakpoint-desktop-px: 896px;');
    expect(responsive).toContain('@media (max-width: 55.999rem)');
    expect(responsive).toContain('@media (min-width: 56rem)');
    expect(responsive).toMatch(/@media \(max-width: 55\.999rem\)[\s\S]*\.bottom-nav\s*\{[\s\S]*display: grid;/);
    expect(responsive).toMatch(/@media \(min-width: 56rem\)[\s\S]*\.desktop-nav\s*\{[\s\S]*display: flex;[\s\S]*\.bottom-nav\s*\{[\s\S]*display: none;/);
    expect(895).toBeLessThan(896);
  });

  it('preserves safe-area spacing and reserves the mobile navigation', () => {
    expect(tokens).toMatch(/--safe-(top|right|bottom|left): env\(safe-area-inset-/);
    expect(shell).toContain('padding: calc(var(--space-3) + var(--safe-top))');
    expect(shell).toContain('padding-bottom: calc(var(--space-1) + var(--safe-bottom));');
    expect(shell).toContain('padding: var(--space-6) max(var(--space-4), var(--safe-right)) calc(var(--space-4) + var(--nav-height) + var(--space-2) + var(--safe-bottom)) max(var(--space-4), var(--safe-left));');
    expect(shell).toContain('inset: 0 0 calc(-1 * (var(--space-1) + var(--safe-bottom))) 0;');
    expect(responsive).toMatch(/@media \(max-width: 30rem\)[\s\S]*\.top-bar\s*\{[\s\S]*padding-right: max\(var\(--space-1\), var\(--safe-right\)\);/);
  });

  it('keeps controls touch-safe, mobile form controls at 16px, and focus visible', () => {
    expect(tokens).toContain('--control-min-height: 2.75rem;');
    expect(base).toContain('button,\na,\ninput,\nselect,\ntextarea');
    expect(base).toContain('font-size: max(16px, 1rem);');
    expect(base).toMatch(/button:focus-visible,[\s\S]*outline: 3px solid var\(--color-primary-focus-ring\);[\s\S]*outline-offset: 3px;/);
    expect(css).toMatch(/\.ui-ledger-row\[href\]:focus-visible\s*\{[\s\S]*outline: 3px solid var\(--color-primary-focus-ring\);/);
    expect(shell).toMatch(/\.bottom-nav\s*\{[\s\S]*grid-template-columns: minmax\(44px, 1fr\) minmax\(44px, 1fr\)/);
    expect(shell).toMatch(/\.nav-item\s*\{[\s\S]*min-height: var\(--nav-height\);/);
    expect(shell).toMatch(/\.split-transaction-control__menu\s*\{[\s\S]*min-width: var\(--control-min-height\);[\s\S]*min-height: var\(--control-min-height\);/);
  });

  it('keeps forced colors and reduced motion usable', () => {
    expect(base).toMatch(/@media \(forced-colors: active\)[\s\S]*select\s*\{[\s\S]*appearance: auto;[\s\S]*background-image: none;/);
    expect(responsive).toMatch(/@media \(forced-colors: active\)[\s\S]*Highlight/);
    expect(responsive).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.01ms/);
  });

  it('keeps loading, cached, offline, and error states explicit in source', () => {
    expect(appSource).toContain('function HomeLoadingPlaceholder()');
    expect(appSource).toContain('function GroupOverviewLoadingPlaceholder()');
    expect(appSource).toContain('<ResourceState');
    expect(appSource).toContain('role="status"');
    expect(appSource).toContain('offline-banner');
    expect(appSource).toContain('cache-status');
    expect(appSource).toContain('Showing cached');
    expect(errorBoundarySource).toContain('role="alert"');
    expect(uiSource).toContain('export function AuthLoadingShell()');
    expect(uiSource).toContain('aria-live="polite"');
    expect(css).toContain('.skeleton {');
  });

  it('keeps the mobile Add geometry, affordance, and focus contracts', () => {
    expect(shell).toMatch(/\.nav-item--add\s*\{[\s\S]*align-items: stretch;[\s\S]*background: transparent;[\s\S]*margin-top: calc\(-1 \* \(var\(--space-2\) \+ 4px\)\);/);
    expect(shell).toMatch(/\.nav-item--add::before\s*\{[\s\S]*background: var\(--color-primary\);[\s\S]*pointer-events: none;/);
    expect(shell).toMatch(/\.nav-item__capsule\s*\{[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*align-self: stretch;[\s\S]*overflow: hidden;/);
    expect(shell).toMatch(/\.bottom-nav \.nav-item__capsule \.split-transaction-control__primary\s*\{[\s\S]*align-items: flex-end;[\s\S]*background: var\(--color-primary\);/);
    expect(shell).toMatch(/\.bottom-nav \.nav-item__capsule \.split-transaction-control__menu\s*\{[\s\S]*min-width: var\(--control-min-height\);[\s\S]*border-left-color: rgba\(255, 255, 255, 0\.45\);/);
    expect(shell).toMatch(/\.bottom-nav \.split-transaction-control\.nav-item__capsule \.split-transaction-control__primary:focus-visible/);
    expect(responsive).toMatch(/@media \(forced-colors: active\)[\s\S]*\.bottom-nav \.split-transaction-control\.nav-item__capsule \.split-transaction-control__menu:focus-visible[\s\S]*Highlight/);
    expect(uiSource).toContain('mobileNav');
    expect(uiSource).toContain('More transaction types');
    expect(uiSource).toContain('aria-label={menuLabel}');
  });

  it('keeps overview macro-cards and allowed route surfaces explicit', () => {
    for (const name of ['group-overview-card--balances', 'group-overview-card--transactions', 'group-overview-card--schedules', 'group-overview-card--people']) expect(appSource).toContain(name);
    expect(appSource).toContain('<ul className="balance-cards">');
    expect(css).toMatch(/\.route-view--group-overview \.balance-card--positive,[\s\S]*border-left: 0\.2rem solid currentColor;/);
    expect(css).toMatch(/\.route-view--group-overview \.balance-card\s*\{[\s\S]*background: transparent;[\s\S]*border-bottom: 1px solid var\(--color-divider\);/);
    expect(css).not.toMatch(/\.route-view--group-overview \.balance-card--(?:positive|debt)\s*\{[^}]*background:\s*var\(--color-(positive|debt)-subtle\)/);
    expect(css).toMatch(/\.insight-metric\s*\{[\s\S]*border-bottom: 1px solid var\(--color-divider\);[\s\S]*padding: var\(--space-3\) 0;/);
    expect(css).not.toMatch(/\.insight-metric\s*\{[^}]*border:\s*1px solid/);
    expect(css).toMatch(/\.insight-summary-card\s*\{[\s\S]*border: 1px solid var\(--color-border\);/);
    expect(css).toMatch(/\.insight-category-trends\s*\{[\s\S]*border: 1px solid var\(--color-border\);/);
    expect(appSource).toContain('className="creation-form-surface"');
    expect(refundSource()).toContain('<FormSurface className="refund-form__surface"><form');
  });

  it('keeps editorial desktop navigation and primary Add hierarchy', () => {
    expect(shell).toMatch(/\.desktop-nav__item\s*\{[\s\S]*border-bottom: 2px solid transparent;[\s\S]*border-radius: 0;/);
    expect(shell).toMatch(/\.split-transaction-control\s*\{[\s\S]*border-radius: var\(--radius-control\);[\s\S]*box-shadow: none;/);
    expect(shell).toMatch(/\.split-transaction-control__primary\s*\{[\s\S]*background: var\(--color-primary\);[\s\S]*font-weight: 700;/);
    expect(uiSource).toContain("compact ? 'Add expense'");
    expect(uiSource).toContain('className="desktop-nav__add"');
    expect(css).toMatch(/\.status\s*\{[\s\S]*border-radius: var\(--radius-pill\);/);
    expect(css).toMatch(/\.chip\s*\{[\s\S]*border-radius: var\(--radius-pill\);/);
  });

  it('keeps semantic source contracts and responsive audit coverage', () => {
    expect(uiSource).toContain('export function Layout(');
    expect(uiSource).toContain('<AppShell>');
    expect(uiSource).toContain('route-view route-view--${routeClass}');
    expect(appSource).toContain('<section className="activity-filter reading-width"');
    expect(appSource).toContain('aria-labelledby="insight-summary-heading"');
    expect(appSource).toContain('aria-labelledby="balances-heading"');
    expect(appSource).toContain('summary="More group actions"');
    expect(auditSource).toContain('const surfaceRootSelector =');
    for (const width of [320, 390, 768, 895, 896, 1440]) expect(auditSource).toContain(`{ width: ${width},`);
    expect(auditSource).toContain('full canonical responsive coverage');
  });
});

function refundSource() {
  return readFileSync(new URL('../refund-form.tsx', import.meta.url), 'utf8');
}
