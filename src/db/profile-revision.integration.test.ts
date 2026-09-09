import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';

const db = (env as unknown as { DB: D1Database }).DB;

describe('database profile revisions', () => {
  it('allocates distinct revisions for concurrent writes with the same timestamp', async () => {
    const userId = crypto.randomUUID();
    await db.batch([
      db.prepare('INSERT INTO users(id,email,created_at,updated_at) VALUES(?,?,?,?)').bind(userId, `${userId}@example.com`, 'same', 'same'),
      db.prepare('INSERT INTO people(id,name,email,user_id,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), 'Profile', `${userId}@example.com`, userId, 'same'),
    ]);

    await Promise.all([
      db.prepare("UPDATE users SET updated_at='same',profile_revision=profile_revision+1 WHERE id=?").bind(userId).run(),
      db.prepare("UPDATE users SET updated_at='same',profile_revision=profile_revision+1 WHERE id=?").bind(userId).run(),
    ]);

    const row = await db.prepare('SELECT profile_revision,updated_at FROM users WHERE id=?').bind(userId).first<{ profile_revision: number; updated_at: string }>();
    expect(row).toEqual({ profile_revision: 2, updated_at: 'same' });
  });
});
