import { describe, expect, it } from 'vitest';
// The application tsconfig intentionally does not include Node types; this
// test runs in Vitest's Node environment and reads the authored stylesheet.
// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./components.css', import.meta.url), 'utf8');

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
});
