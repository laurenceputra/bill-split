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
const shell = read('shell.css');
const responsive = read('responsive.css');

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
    const forcedColors = responsive.match(/@media \(forced-colors: active\)([\s\S]*?)(?=@media|$)/)?.[1] ?? '';
    for (const control of ['primary', 'menu']) {
      expect(forcedColors).toMatch(new RegExp(`\\.bottom-nav \\.split-transaction-control\\.nav-item__capsule \\.split-transaction-control__${control}:focus-visible\\s*\\{[^}]*box-shadow:[^}]*Highlight`));
    }
    expect(responsive).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.01ms/);
  });

});
