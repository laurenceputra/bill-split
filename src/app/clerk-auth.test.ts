import { describe, expect, it } from 'vitest';
// These checks keep the authentication boundary intentional without requiring
// a live Clerk instance or browser session.
// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const main = read('./main.tsx');
const app = read('./App.tsx');
const ui = read('./ui.tsx');
const api = read('./api.ts');
const e2eServer = read('../../tests/e2e/start-server.mjs');

describe('Clerk authentication boundary', () => {
  it('uses the provider environment convention without manually passing a publishable key', () => {
    expect(main).toContain('<ClerkProvider>');
    expect(main).not.toContain('publishableKey=');
  });

  it('offers email-code-compatible sign-in and public signup controls', () => {
    expect(app).toContain('SignInButton');
    expect(app).toContain('SignUpButton');
    expect(ui).toContain('SignInButton');
    expect(ui).toContain('SignUpButton');
    expect(app).not.toMatch(/<Signed(?:In|Out)\b/);
    expect(ui).not.toMatch(/<Signed(?:In|Out)\b/);
  });

  it('clears local private state before Clerk sign-out', () => {
    expect(app.lastIndexOf('clearEverythingForLogout')).toBeLessThan(app.lastIndexOf('signOut({ redirectUrl: \'/\' })'));
    expect(api).not.toContain('Cloudflare');
  });

  it('tracks Clerk user and session changes and permits an offline cold start', () => {
    expect(app).toContain('userId, sessionId');
    expect(app).toContain('resetForClerkSessionChange');
    expect(app).toContain('!isLoaded && !online');
    expect(api).toContain('shouldStartAuthCheck');
  });

  it('blocks private resources and routes while an account transition is being verified', () => {
    expect(api).toContain('blockResourceIdentity');
    expect(app).toContain('sessionTransitionPending');
    expect(app).toContain('authoritativeClerkIdentityReady');
    expect(app).toContain('if (auth.status === \'authenticated\' && (sessionTransitionPending || !authoritativeClerkIdentityReady))');
  });

  it('keeps the real-session bypass confined to the local E2E build and development Worker', () => {
    expect(api).toContain('VITE_DEV_AUTH_BYPASS');
    expect(e2eServer).toContain("VITE_DEV_AUTH_BYPASS: 'true'");
    expect(e2eServer).toContain("'--env', 'dev'");
  });
});
