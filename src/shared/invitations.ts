export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

export const INVITATION_DEFAULT_DAYS = 30;

export function invitationExpiry(from = new Date()): string {
  const expiry = new Date(from.getTime());
  expiry.setUTCDate(expiry.getUTCDate() + INVITATION_DEFAULT_DAYS);
  return expiry.toISOString();
}
