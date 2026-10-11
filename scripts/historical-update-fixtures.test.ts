import { describe, expect, it } from 'vitest';
import { assertHistoricalSource, historicalManifest, readHistoricalSource, verifyHistoricalFixtures } from '../tests/e2e/fixtures/historical-sources.mjs';

describe('vendored historical update provenance', () => {
  it('verifies every verbatim source snapshot without Git or network access', async () => {
    expect(Object.values(historicalManifest).flatMap((entry: any) => Object.keys(entry.files))).toHaveLength(10);
    await verifyHistoricalFixtures();
  });
  it.each(['../src/app/idb.ts', 'src/app/api.ts', '__proto__'])('rejects unlisted source paths: %s', async (path) => {
    await expect(readHistoricalSource('oldest', path)).rejects.toThrow('not in the provenance manifest');
  });
  it('rejects unknown snapshots and corrupted bytes rather than substituting current code', async () => {
    await expect(readHistoricalSource('__proto__', 'public/sw.js')).rejects.toThrow('not in the provenance manifest');
    const bytes = Buffer.from(await readHistoricalSource('oldest', 'public/sw.js'));
    bytes[0] ^= 1;
    expect(() => assertHistoricalSource('oldest', 'public/sw.js', bytes)).toThrow('checksum mismatch');
  });
});
