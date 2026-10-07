import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Main e2e configuration provides the real Worker/ASSETS server and baseURL.
// Keep this integration separate from the standalone artifact lifecycle suite.
test('Worker canonical endpoint serves the real ASSETS file despite range and conditional headers', async ({ request }) => {
  const expected = await readFile(new URL('../../dist/index.html', import.meta.url));
  for (const headers of [{}, { Range: 'bytes=0-10', 'If-None-Match': '*', 'If-Modified-Since': 'Wed, 07 Oct 2099 00:00:00 GMT' }]) {
    const response = await request.get('/__billsplit_shell__.bin', { headers });
    expect(response.status()).toBe(200);
    expect(await response.body()).toEqual(expected);
    expect(response.headers()['content-type']).toBe('application/octet-stream');
    expect(response.headers()['cache-control']).toBe('no-cache, no-transform');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
  }
  const head = await request.head('/__billsplit_shell__.bin');
  expect(head.status()).toBe(200);
  expect((await head.body()).length).toBe(0);
  expect((await request.post('/__billsplit_shell__.bin')).status()).toBe(405);
});
