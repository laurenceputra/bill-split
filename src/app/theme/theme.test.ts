import { describe, expect, it } from 'vitest';
// The application tsconfig intentionally does not include Node types; this
// test runs in Vitest's Node environment and reads the authored stylesheet.
// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./components.css', import.meta.url), 'utf8');
const baseCss = readFileSync(new URL('./base.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

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
  });

  it('spaces closed People chips without adding a second open-form gap', () => {
    const peopleSection = appSource.match(/<section><div className="section-title">[\s\S]*?<div className="chips">[\s\S]*?<\/section>/)?.[0] ?? '';

    expect(css).toMatch(/\.section-title\s*\+\s*\.chips\s*\{\s*margin-top: var\(--space-3\);\s*\}/);
    expect(peopleSection).toMatch(/<div className="section-title">[\s\S]*\{!offlineView && addingPerson && <form/);
    expect(peopleSection).toMatch(/<\/form>\}<div className="chips">/);
  });

  it('keeps activity row focus visible inside clipped lists', () => {
    expect(css).toMatch(/\.row\[href\]:focus-visible\s*\{[\s\S]*box-shadow: inset 0 0 0 3px var\(--color-focus\);[\s\S]*outline: 3px solid var\(--color-focus\);[\s\S]*outline-offset: -3px;/);
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

  it('defines every spacing token referenced by the authored stylesheets', () => {
    const references = [...`${css}\n${baseCss}`.matchAll(/var\(--(space-\d+)\)/g)].map((match) => match[1]);
    expect([...new Set(references)].every((token) => new RegExp(`--${token}\\s*:`).test(tokensCss))).toBe(true);
  });
});
