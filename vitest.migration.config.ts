import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/db/migrations.integration.test.ts'],
    testTimeout: 300_000,
  },
});
