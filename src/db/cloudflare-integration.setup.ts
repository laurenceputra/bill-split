/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { D1Database } from '@cloudflare/workers-types';

const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
