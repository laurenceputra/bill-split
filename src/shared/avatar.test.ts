import { describe, expect, it } from 'vitest';
import { accountAvatar, avatarPreference, avatarUrl } from './avatar';
import { profileNameInput } from './schemas';

describe('account avatar preferences', () => {
  it('defaults legacy profiles to initials without retaining image metadata', async () => {
    expect(avatarPreference({})).toEqual({ avatarMode: 'initials', avatarHash: undefined });
    expect(await accountAvatar(undefined, 'account@example.com')).toEqual({ avatarMode: 'initials' });
    expect(avatarUrl({ avatarMode: 'initials', avatarHash: 'a'.repeat(64) })).toBeUndefined();
  });
  it('uses SHA-256 of trimmed lowercased account email and a 404 fallback', async () => {
    const profile = await accountAvatar('gravatar', ' Account@Example.com ');
    expect(profile).toEqual(await accountAvatar('gravatar', 'account@example.com'));
    expect(profile.avatarHash).toBe('fe006b9c8131fae9b27a9e0fdbc2bd95b0bf677e6805dea433ae5967fe101c39');
    expect(await accountAvatar('gravatar', '')).toEqual({ avatarMode: 'gravatar' });
    expect(avatarUrl(profile)).toBe(`https://gravatar.com/avatar/${profile.avatarHash}?s=96&r=g&d=404`);
    expect(avatarUrl({ avatarMode: 'gravatar', avatarHash: 'https://evil.test' })).toBeUndefined();
  });
  it('accepts explicit preferences and older name-only clients, not unknown modes', () => {
    expect(profileNameInput.parse({ name: ' Name ', avatarMode: 'gravatar' })).toEqual({ name: 'Name', avatarMode: 'gravatar' });
    expect(profileNameInput.parse({ name: 'Name' })).toEqual({ name: 'Name' });
    expect(profileNameInput.safeParse({ name: 'Name', avatarMode: 'clerk' }).success).toBe(false);
    expect(profileNameInput.safeParse({ name: 'Name', avatarMode: null }).success).toBe(false);
  });
});
