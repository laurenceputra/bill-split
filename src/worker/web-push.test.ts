import { describe, expect, it, vi } from 'vitest';
import { decryptSubscription, encryptSubscription, sendWebPush } from './web-push';

const b64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const fromB64 = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; };
const hmac = async (keyBytes: Uint8Array, value: Uint8Array) => {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, value));
};
const hkdfExpand = async (prk: Uint8Array, info: Uint8Array, length: number) => {
  const chunks: Uint8Array[] = []; let previous = new Uint8Array();
  for (let counter = 1; concat(...chunks).length < length; counter += 1) { previous = await hmac(prk, concat(previous, info, new Uint8Array([counter]))); chunks.push(previous); }
  return concat(...chunks).slice(0, length);
};

describe('Worker Web Push implementation', () => {
  it('round-trips encrypted subscription material without storing an endpoint in plaintext', async () => {
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/opaque-token', keys: { p256dh: 'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU', auth: b64(new Uint8Array(16).fill(7)) } };
    const ciphertext = await encryptSubscription(subscription, 'test-encryption-secret');
    expect(ciphertext).not.toContain(subscription.endpoint);
    await expect(decryptSubscription(ciphertext, 'test-encryption-secret')).resolves.toEqual(subscription);
  });

  it('rejects malformed subscription key material before encryption or delivery', async () => {
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/opaque-token', keys: { p256dh: b64(new Uint8Array(65).fill(4)), auth: b64(new Uint8Array(16).fill(7)) } };
    await expect(encryptSubscription(subscription, 'test-encryption-secret')).rejects.toThrow(/key material|P-256/i);
    await expect(sendWebPush(subscription, '{}', { privateKey: 'unused', publicKey: 'unused', contact: 'mailto:test@example.test' })).rejects.toThrow(/key material|P-256/i);
  });

  it('sends standards-compatible aes128gcm payloads with a VAPID authorization header', async () => {
    const client = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const clientPublic = new Uint8Array(await crypto.subtle.exportKey('raw', client.publicKey) as ArrayBuffer);
    const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', vapid.privateKey) as JsonWebKey & { d: string; x: string; y: string };
    const publicKey = b64(new Uint8Array([4, ...fromB64(jwk.x), ...fromB64(jwk.y)]));
    let authorization = '';
    let encryptedBody = new Uint8Array();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' });
      authorization = String((init?.headers as Record<string, string>).Authorization);
      encryptedBody = new Uint8Array(init?.body as ArrayBuffer);
      expect(authorization).toContain('vapid t=');
      expect((init?.body as Uint8Array).byteLength).toBeGreaterThan(80);
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const response = await sendWebPush({ endpoint: 'https://fcm.googleapis.com/fcm/send/opaque-token', keys: { p256dh: b64(clientPublic), auth: b64(new Uint8Array(16).fill(8)) } }, '{"title":"BillSplit activity"}', { privateKey: jwk.d, publicKey, contact: 'mailto:test@example.test' });
      expect(response.status).toBe(201);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const token = authorization.match(/^vapid t=([^,]+), k=/)?.[1];
      expect(token).toBeTruthy();
      const [header, body, signature] = token!.split('.');
      const publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } satisfies JsonWebKey;
      const verifyKey = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, fromB64(signature), new TextEncoder().encode(`${header}.${body}`))).toBe(true);

      // Independently derive the aes128gcm content key and nonce as a browser
      // push receiver would, rather than merely checking that the body is nonempty.
      const salt = encryptedBody.slice(0, 16);
      const serverPublic = encryptedBody.slice(21, 86);
      const ciphertext = encryptedBody.slice(86);
      const serverKey = await crypto.subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey } as any, client.privateKey, 256));
      const authInfo = concat(new TextEncoder().encode('WebPush: info\0'), clientPublic, serverPublic);
      const authPrk = await hmac(new Uint8Array(16).fill(8), shared);
      const ikm = await hkdfExpand(authPrk, authInfo, 32);
      const contentPrk = await hmac(salt, ikm);
      const cek = await hkdfExpand(contentPrk, concat(new TextEncoder().encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
      const nonce = await hkdfExpand(contentPrk, concat(new TextEncoder().encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);
      const contentKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, contentKey, ciphertext));
      expect(new TextDecoder().decode(plaintext.slice(0, -1))).toBe('{"title":"BillSplit activity"}');
      expect(plaintext.at(-1)).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a VAPID key with correctly sized bytes but invalid curve coordinates', async () => {
    const client = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const clientPublic = new Uint8Array(await crypto.subtle.exportKey('raw', client.publicKey) as ArrayBuffer);
    const invalidPoint = b64(new Uint8Array([4, ...new Uint8Array(64).fill(1)]));
    await expect(sendWebPush(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/opaque-token', keys: { p256dh: b64(clientPublic), auth: b64(new Uint8Array(16).fill(8)) } },
      '{"title":"BillSplit activity"}',
      { privateKey: 'unused', publicKey: invalidPoint, contact: 'mailto:test@example.test' },
    )).rejects.toThrow(/P-256|curve|key/i);
  });
});
