import { describe, expect, it } from 'vitest';
import { invitationExpiry, normalizeEmail } from './invitations';
import { invitationInput } from './schemas';

describe('in-app invitations', () => {
  it('normalizes the verified email target without creating a bearer token', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com');
    expect(invitationInput.parse({ email: '  Person@Example.COM ' }).email).toBe('Person@Example.COM');
  });

  it('defaults expiry to exactly thirty UTC calendar days', () => {
    expect(invitationExpiry(new Date('2026-01-01T12:00:00.000Z'))).toBe('2026-01-31T12:00:00.000Z');
  });
});
