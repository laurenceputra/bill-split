import { describe, expect, it } from 'vitest';
import { APPLICATION_SESSION_IDLE_MS } from '../shared/session-policy';
import { APPLICATION_SESSION_COOKIE, CSRF_COOKIE, DEVELOPMENT_APPLICATION_SESSION_COOKIE, constantTimeEqual, cookieValue, randomSessionToken, serializeCookie, sessionCookieName, sha256Hex } from './application-session';

describe('application session credentials', () => {
  it('generates a 256-bit opaque token and stores only its SHA-256 digest', async () => {
    const token = randomSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sha256Hex(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('uses the host cookie only in production and applies the fixed cookie policy', () => {
    expect(sessionCookieName('production')).toBe(APPLICATION_SESSION_COOKIE);
    expect(sessionCookieName('development')).toBe(DEVELOPMENT_APPLICATION_SESSION_COOKIE);
    const cookie = serializeCookie(APPLICATION_SESSION_COOKIE, 'opaque', { maxAge: APPLICATION_SESSION_IDLE_MS / 1000, httpOnly: true, secure: true });
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=2592000');
  });

  it('parses host-only CSRF values and compares them without an early equality exit', () => {
    const request = new Request('https://split.example/', { headers: { Cookie: `${CSRF_COOKIE}=csrf-value; ${APPLICATION_SESSION_COOKIE}=session-value` } });
    expect(cookieValue(request, CSRF_COOKIE)).toBe('csrf-value');
    expect(constantTimeEqual('csrf-value', 'csrf-value')).toBe(true);
    expect(constantTimeEqual('csrf-value', 'other')).toBe(false);
  });
});
