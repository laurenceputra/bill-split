export type AvatarMode = 'initials' | 'gravatar';
export interface AvatarPreference { avatarMode?: AvatarMode; avatarHash?: string }

export function normalizeAvatarMode(value: unknown): AvatarMode {
  return value === 'gravatar' ? 'gravatar' : 'initials';
}

export function avatarPreference(value: AvatarPreference): AvatarPreference {
  const avatarMode = normalizeAvatarMode(value.avatarMode);
  return { avatarMode, avatarHash: avatarMode === 'gravatar' ? value.avatarHash : undefined };
}

/** Hash only opted-in account emails; never publish a raw email for an avatar. */
export async function accountAvatar(mode: unknown, email: string): Promise<AvatarPreference> {
  const avatarMode = normalizeAvatarMode(mode);
  if (avatarMode === 'initials' || !email.trim()) return { avatarMode };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  return { avatarMode, avatarHash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') };
}

export function avatarUrl(preference: AvatarPreference): string | undefined {
  return preference.avatarMode === 'gravatar' && /^[a-f0-9]{64}$/.test(preference.avatarHash || '')
    ? `https://gravatar.com/avatar/${preference.avatarHash}?s=96&r=g&d=404` : undefined;
}
