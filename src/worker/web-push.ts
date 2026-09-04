/* Web Push primitives implemented with the Workers Web Crypto API. The
 * popular `web-push` package depends on Node's crypto/http modules and is not
 * suitable for a Worker bundle. */

import { normalizeSupportedPushEndpoint } from '../shared/push-endpoints';

const encoder = new TextEncoder();

export type StoredPushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

const toBase64Url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const fromBase64Url = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const copy = (value: Uint8Array) => { const result = new Uint8Array(value.length); result.set(value); return result; };
const u8 = (value: ArrayBuffer | Uint8Array) => value instanceof Uint8Array ? value : new Uint8Array(value);

async function digest(name: 'SHA-256', value: string | Uint8Array) {
  return u8(await crypto.subtle.digest(name, typeof value === 'string' ? encoder.encode(value) : value));
}
async function hmacBytes(value: Uint8Array, secret: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return u8(await crypto.subtle.sign('HMAC', key, value));
}
async function hmac(value: string, secret: string) {
  return hmacBytes(encoder.encode(value), encoder.encode(secret));
}

/** Hashes are keyed so an endpoint cannot be checked against a public rainbow table. */
export async function endpointHash(endpoint: string, secret: string) {
  return [...await hmac(endpoint, secret)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptionKey(secret: string) {
  const candidate = /^[A-Za-z0-9_-]{43,44}$/.test(secret) ? (() => { try { return fromBase64Url(secret); } catch { return undefined; } })() : undefined;
  const bytes = candidate?.length === 32 ? candidate : await digest('SHA-256', secret);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSubscription(subscription: StoredPushSubscription, secret: string) {
  const endpoint = normalizeSupportedPushEndpoint(subscription.endpoint);
  if (!endpoint) throw new Error('Invalid push subscription');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const ciphertext = u8(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify({ ...subscription, endpoint }))));
  return `v1.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

export async function decryptSubscription(ciphertext: string, secret: string): Promise<StoredPushSubscription> {
  const [version, encodedIv, encodedCiphertext] = ciphertext.split('.');
  if (version !== 'v1' || !encodedIv || !encodedCiphertext) throw new Error('Invalid subscription ciphertext');
  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(encodedIv) }, key, fromBase64Url(encodedCiphertext));
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as StoredPushSubscription;
  const endpoint = normalizeSupportedPushEndpoint(parsed.endpoint);
  if (!endpoint || typeof parsed.keys?.p256dh !== 'string' || typeof parsed.keys?.auth !== 'string') throw new Error('Invalid stored subscription');
  return { endpoint, keys: { p256dh: parsed.keys.p256dh, auth: parsed.keys.auth } };
}

const extract = async (salt: Uint8Array, value: Uint8Array) => hmacBytes(value, salt);
const expand = async (prk: Uint8Array, infoValue: Uint8Array, length: number) => {
  const chunks: Uint8Array[] = [];
  let previous = new Uint8Array();
  for (let counter = 1; chunks.reduce((total, chunk) => total + chunk.length, 0) < length; counter += 1) {
    previous = copy(await hmacBytes(concat(previous, infoValue, new Uint8Array([counter])), prk));
    chunks.push(previous);
  }
  return concat(...chunks).slice(0, length);
};
const info = (label: string) => concat(encoder.encode(label), new Uint8Array([0]));

async function encryptedBody(subscription: StoredPushSubscription, payload: string) {
  const clientPublic = fromBase64Url(subscription.keys.p256dh);
  const auth = fromBase64Url(subscription.keys.auth);
  if (clientPublic.length !== 65 || clientPublic[0] !== 4 || auth.length !== 16) throw new Error('Invalid Web Push key material');
  const clientKey = await crypto.subtle.importKey('raw', clientPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const server = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const serverPublic = u8(await crypto.subtle.exportKey('raw', server.publicKey as CryptoKey) as unknown as ArrayBuffer);
  // `public` is the Web Crypto standard spelling. The Workers type package
  // currently exposes its compatibility alias as `$public`, hence the narrow
  // cast at this API boundary.
  const shared = u8(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey } as any, server.privateKey, 256));
  const authInfo = concat(encoder.encode('WebPush: info\0'), clientPublic, serverPublic);
  const ikm = await expand(await extract(auth, shared), authInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await extract(salt, ikm);
  const cek = await expand(prk, info('Content-Encoding: aes128gcm'), 16);
  const nonce = await expand(prk, info('Content-Encoding: nonce'), 12);
  const content = concat(encoder.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = u8(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, content));
  const recordSize = new Uint8Array([0, 0, 0x10, 0]); // 4096-byte records
  return concat(salt, recordSize, new Uint8Array([serverPublic.length]), serverPublic, ciphertext);
}

const jwtPart = (value: unknown) => toBase64Url(encoder.encode(JSON.stringify(value)));
const publicCoordinates = (publicKey: string) => {
  const bytes = fromBase64Url(publicKey);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('VAPID public key must be an uncompressed P-256 key');
  return { x: toBase64Url(bytes.slice(1, 33)), y: toBase64Url(bytes.slice(33, 65)) };
};

const validatePublicKey = async (publicKey: string) => {
  const coordinates = publicCoordinates(publicKey);
  // Importing the raw point is intentional: length and the uncompressed-point
  // prefix do not prove that the coordinates are on the P-256 curve.
  await crypto.subtle.importKey('raw', fromBase64Url(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return coordinates;
};

async function vapidToken(endpoint: string, config: { privateKey: string; publicKey: string; contact: string }) {
  const url = new URL(endpoint);
  const header = jwtPart({ typ: 'JWT', alg: 'ES256' });
  const body = jwtPart({ aud: url.origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: config.contact });
  const coordinates = await validatePublicKey(config.publicKey);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: coordinates.x, y: coordinates.y, d: config.privateKey }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = u8(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${header}.${body}`)));
  if (signature.length !== 64) throw new Error('Worker ECDSA did not return a JWT-compatible signature');
  return `${header}.${body}.${toBase64Url(signature)}`;
}

export async function sendWebPush(subscription: StoredPushSubscription, payload: string, config: { privateKey: string; publicKey: string; contact: string }) {
  const endpoint = normalizeSupportedPushEndpoint(subscription.endpoint);
  if (!endpoint) throw new Error('Invalid push subscription');
  const body = await encryptedBody({ ...subscription, endpoint }, payload);
  const token = await vapidToken(endpoint, config);
  const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 15_000);
  try {
    return await fetch(endpoint, { method: 'POST', headers: {
      Authorization: `vapid t=${token}, k=${config.publicKey}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Urgency: 'normal',
    }, body, ...(controller ? { signal: controller.signal } : {}) });
  } finally { clearTimeout(timeout); }
}
