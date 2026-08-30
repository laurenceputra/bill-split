export const APPLICATION_SESSION_COOKIE = '__Host-billsplit_session';
export const DEVELOPMENT_APPLICATION_SESSION_COOKIE = 'billsplit_session';
export const CSRF_COOKIE = 'billsplit_csrf';
export const CSRF_HEADER = 'X-BillSplit-CSRF';

const base64Url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

/** Generate exactly 256 bits. This value is never logged or persisted. */
export const randomSessionToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
};

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const sessionCookieName = (environment?: string) => environment === 'development' || environment === 'test' ? DEVELOPMENT_APPLICATION_SESSION_COOKIE : APPLICATION_SESSION_COOKIE;
export const cookieValue = (request: Request, name: string) => {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
};

export const serializeCookie = (name: string, value: string, options: { maxAge?: number; httpOnly?: boolean; secure?: boolean } = {}) => {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
};

export const constantTimeEqual = (left: string | undefined, right: string | undefined) => {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};
