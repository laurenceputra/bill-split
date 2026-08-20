import { describe, expect, it } from 'vitest';
// The worker tsconfig intentionally does not include Node types; this test
// runs in Vitest's Node environment and reads the authored migration.
// @ts-expect-error Node types are not shipped to the Worker build.
import { readFileSync } from 'node:fs';

// @ts-expect-error Vitest supplies import.meta.url at runtime.
const sql = readFileSync(new URL('../../migrations/0004_friend_idempotency_lookup.sql', import.meta.url), 'utf8');

describe('friend idempotency migration', () => {
  it('enforces one friend claim per user and operation, independent of group', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*ON idempotency_keys\(user_id, operation_id\)[\s\S]*WHERE kind = 'friend\.create'/i);
    expect(sql).not.toMatch(/UNIQUE INDEX[\s\S]*group_id/i);
  });
});
