import { describe, expect, it, vi } from 'vitest';
import worker from './index';

describe('standalone update recovery', () => {
  it.each(['GET', 'HEAD'])('%s bypasses auth, assets and database without cookies', async (method) => {
    const prepare = vi.fn(() => { throw new Error('must not access storage'); });
    const fetch = vi.fn(() => { throw new Error('must not boot app'); });
    const response = await worker.fetch(new Request('https://split.example/api/app-update-recovery?input=%3Cscript%3E', { method }), { DB: { prepare }, ASSETS: { fetch } } as any, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    const body = await response.text();
    if (method === 'HEAD') expect(body).toBe('');
    else {
      expect(body).toContain('including this recovery page');
      expect(body).toContain('Let ongoing writes finish');
      expect(body).not.toMatch(/<script|indexedDB|unregister|location\.reload|caches\.delete/);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['/api/app-update-recovery/', '/api/app-update-recovery/extra'])('does not broaden the public exception to %s', async (path) => {
    const response = await worker.fetch(new Request(`https://split.example${path}`), { DB: {}, ASSETS: {} } as any, {} as ExecutionContext);
    expect(response.status).toBe(401);
  });
  it('does not allow mutations through the public exception', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/app-update-recovery', { method: 'POST' }), { DB: {}, ASSETS: {} } as any, {} as ExecutionContext);
    expect(response.status).toBe(403);
  });
});
