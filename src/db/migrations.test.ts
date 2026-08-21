import { describe, expect, it } from 'vitest';
// The worker tsconfig intentionally does not include Node types; this test
// runs in Vitest's Node environment and reads the authored migration.
// @ts-expect-error Node types are not shipped to the Worker build.
import { readFileSync } from 'node:fs';

// @ts-expect-error Vitest supplies import.meta.url at runtime.
const friendSql = readFileSync(new URL('../../migrations/0004_friend_idempotency_lookup.sql', import.meta.url), 'utf8');
// @ts-expect-error Vitest supplies import.meta.url at runtime.
const clerkSql = readFileSync(new URL('../../migrations/0005_clerk_identity.sql', import.meta.url), 'utf8');

describe('friend idempotency migration', () => {
  it('enforces one friend claim per user and operation, independent of group', () => {
    expect(friendSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*ON idempotency_keys\(user_id, operation_id\)[\s\S]*WHERE kind = 'friend\.create'/i);
    expect(friendSql).not.toMatch(/UNIQUE INDEX[\s\S]*group_id/i);
  });
});

describe('Clerk identity migration', () => {
  it('adds a nullable Clerk mapping with a unique partial index', () => {
    expect(clerkSql).toMatch(/ALTER TABLE users ADD COLUMN clerk_user_id TEXT/i);
    expect(clerkSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*ON users\(clerk_user_id\)[\s\S]*WHERE clerk_user_id IS NOT NULL/i);
  });
});
