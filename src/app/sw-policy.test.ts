import { describe, expect, it } from 'vitest';
import { cacheControlAllowsStorage, extractShellAssetPaths, isSafeFinalResponse } from './sw-policy';

describe('service-worker shell policy', () => {
  it('extracts only same-origin hashed assets', () => {
    expect(extractShellAssetPaths('<script src="/assets/app-123.js"></script><link href="/assets/app-123.css"><script src="https://evil.test/app.js"></script>', 'https://split.test')).toEqual(['/assets/app-123.js', '/assets/app-123.css']);
  });

  it('rejects redirected, private, and wrong-type responses', () => {
    expect(cacheControlAllowsStorage('public, max-age=0')).toBe(true);
    expect(cacheControlAllowsStorage('private, no-store')).toBe(false);
    const base = { ok: true, redirected: false, responseUrl: 'https://split.test/index.html', expectedOrigin: 'https://split.test', expectedPath: '/index.html', contentType: 'text/html', cacheControl: 'public' };
    expect(isSafeFinalResponse(base, /text\/html/)).toBe(true);
    expect(isSafeFinalResponse({ ...base, redirected: true }, /text\/html/)).toBe(false);
    expect(isSafeFinalResponse({ ...base, contentType: 'text/html', responseUrl: 'https://split.test/cdn-cgi/access/login' }, /text\/html/)).toBe(false);
  });
});
