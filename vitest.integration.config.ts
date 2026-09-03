import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.vitest.toml' },
    miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
  })],
  test: {
    include: ['src/db/group-summary.integration.test.ts', 'src/db/group-summary.performance.test.ts'],
    setupFiles: ['./src/db/cloudflare-integration.setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
