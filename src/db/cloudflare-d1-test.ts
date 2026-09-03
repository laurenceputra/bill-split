/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';

export const db = (env as unknown as { DB: D1Database }).DB;

/** D1 exec is intentionally single-statement in the Workers test runtime. */
export async function executeSql(script: string) {
  const statements = script.split(';').map((statement) => statement.trim()).filter(Boolean);
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50).map((statement) => db.prepare(statement)));
  }
}

export const all = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...args: unknown[]) =>
  (await db.prepare(sql).bind(...args).all<T>()).results;
