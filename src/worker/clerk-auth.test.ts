import { describe, expect, it } from 'vitest';
import { authenticateClerkSession } from './clerk-auth';

describe('Clerk authentication boundary', () => {
  it('passes session-token and authorized-party requirements to the SDK and accepts verified claims', async () => {
    const result = await authenticateClerkSession(new Request('https://app.example.test/api/me', { headers: { Cookie: '__session=fixture-session-token' } }), {
      publishableKey: 'pk_test_fixture',
      secretKey: 'sk_test_fixture',
      jwtKey: '-----BEGIN PUBLIC KEY-----fixture-----END PUBLIC KEY-----',
      authorizedParties: ' https://app.example.test, https://preview.invalid ',
    }, async (request, options) => {
      expect(request.headers.get('Cookie')).toContain('__session=fixture-session-token');
      expect(options).toEqual({ acceptsToken: 'session_token', authorizedParties: ['https://app.example.test', 'https://preview.invalid'] });
      return { isAuthenticated: true, status: 'signed-in', toAuth: () => ({ isAuthenticated: true, userId: 'user_clerk_1', sessionClaims: { sub: 'user_clerk_1', azp: 'https://app.example.test', primaryEmail: 'User@Example.com' } }) };
    });
    expect(result).toMatchObject({ clerkUserId: 'user_clerk_1', primaryEmail: 'user@example.com' });
  });

  it('rejects a verified-looking session with an unauthorized azp', async () => {
    await expect(authenticateClerkSession(new Request('https://app.example.test/api/me'), { publishableKey: 'pk_test_fixture', secretKey: 'sk_test_fixture', jwtKey: 'fixture', authorizedParties: 'https://app.example.test' }, async () => ({
      isAuthenticated: true,
      status: 'signed-in',
      toAuth: () => ({ isAuthenticated: true, userId: 'user_clerk_1', sessionClaims: { sub: 'user_clerk_1', azp: 'https://evil.invalid', primaryEmail: 'user@example.com' } }),
    }))).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });

  it('distinguishes a token verification failure from a missing session', async () => {
    await expect(authenticateClerkSession(new Request('https://app.example.test/api/me'), { publishableKey: 'pk_test_fixture', secretKey: 'sk_test_fixture', jwtKey: 'fixture', authorizedParties: 'https://app.example.test' }, async () => ({
      isAuthenticated: false,
      status: 'signed-out',
      reason: 'token-invalid',
      toAuth: () => ({ isAuthenticated: false, userId: null, sessionClaims: null }),
    }))).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });

  it('reports a missing secret as configuration before invoking the Clerk client', async () => {
    let invoked = false;
    await expect(authenticateClerkSession(new Request('https://app.example.test/api/me'), {
      publishableKey: 'pk_test_fixture',
      jwtKey: 'fixture',
      authorizedParties: 'https://app.example.test',
    }, async () => {
      invoked = true;
      throw new Error('should not be called');
    })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(invoked).toBe(false);
  });
});
