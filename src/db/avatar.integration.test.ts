import { describe, expect, it } from 'vitest';
import { db } from './cloudflare-d1-test';
import { Repository } from './repository';
import { accountAvatar } from '../shared/avatar';
import worker from '../worker/index';

describe('persisted account avatar', () => {
  it('defaults to initials, saves opt-in with a revision, preserves it for name-only clients and rejects invalid API modes', async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const request = (method: string, body?: unknown) => worker.fetch(new Request('https://split.example/api/me', {
      method, headers: { Origin: 'https://split.example', 'Content-Type': 'application/json', 'X-Dev-Email': email },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), { DB: db, ENVIRONMENT: 'development', ASSETS: { fetch: async () => new Response() } } as never, {} as ExecutionContext);
    const initial = await (await request('GET')).json() as { id: string; avatarMode: string; profileRevision: number };
    expect(initial).toMatchObject({ avatarMode: 'initials', profileRevision: 0 });
    const saved = await request('PUT', { name: 'Account Name', avatarMode: 'gravatar' });
    expect(saved.status).toBe(200);
    const preference = await accountAvatar('gravatar', email);
    expect(await saved.json()).toMatchObject({ user: { ...preference, profileRevision: 1 } });
    expect(await (await request('PUT', { name: 'Older client' })).json()).toMatchObject({ user: { ...preference, profileRevision: 2 } });
    expect((await request('PUT', { name: 'Invalid', avatarMode: 'clerk' })).status).toBe(400);
    expect(await db.prepare('SELECT avatar_mode,profile_revision FROM users WHERE id=?').bind(initial.id).first()).toEqual({ avatar_mode: 'gravatar', profile_revision: 2 });
    await expect(db.prepare("UPDATE users SET avatar_mode='invalid' WHERE id=?").bind(initial.id).run()).rejects.toThrow();
    expect(await (await request('PUT', { name: 'Private', avatarMode: 'initials' })).json()).toMatchObject({ user: { avatarMode: 'initials', profileRevision: 3 } });
    expect(await (await request('GET')).json()).not.toHaveProperty('avatarHash');
  });

  it('shares only avatar metadata in peer summaries and uses account rather than ledger email, including application sessions', async () => {
    const repo = new Repository(db);
    const owner = await new Repository(db, 'fixture-key').user(`${crypto.randomUUID()}@example.com`);
    const peer = await new Repository(db, 'fixture-key').user(`${crypto.randomUUID()}@example.com`);
    const ownerId = String(owner.user.id), peerId = String(peer.user.id);
    const groupId = crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO groups(id,name,currency,kind,created_at,updated_at) VALUES(?,'Peer','USD','peer','now','now')").bind(groupId),
      db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES(?,?,?,'now','owner')").bind(groupId, owner.person.id, ownerId),
      db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES(?,?,?,'now','member')").bind(groupId, peer.person.id, peerId),
      db.prepare("UPDATE people SET email='different-ledger@example.com' WHERE id=?").bind(peer.person.id),
    ]);
    await repo.updateDisplayName(peerId, 'Saved Peer', 'gravatar');
    const preference = await accountAvatar('gravatar', String(peer.user.email));
    expect((await repo.members(groupId)).find((member) => member.personId === peer.person.id)).toMatchObject({ name: 'Saved Peer', ...preference });
    const summary = (await repo.groups(ownerId)).find((group) => group.id === groupId);
    expect(summary).toMatchObject({ counterpartName: 'Saved Peer', counterpartAvatar: preference });
    expect(JSON.stringify(summary)).not.toContain(String(peer.user.email));
    expect(await repo.group(groupId, ownerId)).toMatchObject({ counterpartAvatar: preference });
    await repo.createApplicationSession(peerId, 'a'.repeat(64));
    expect(await repo.applicationSession('a'.repeat(64))).toMatchObject(preference);
    await db.prepare("UPDATE groups SET kind='named' WHERE id=?").bind(groupId).run();
    expect((await repo.groups(ownerId)).find((group) => group.id === groupId)).toMatchObject({ counterpartName: 'Saved Peer', counterpartAvatar: preference });
    const ledgerPerson = crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO people(id,name,created_at) VALUES(?,'A Ledger Only','now')").bind(ledgerPerson),
      db.prepare("INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES(?,?,'now','member')").bind(groupId, ledgerPerson),
    ]);
    expect((await repo.groups(ownerId)).find((group) => group.id === groupId)).toMatchObject({ counterpartName: 'A Ledger Only', counterpartAvatar: { avatarMode: 'initials' } });
    expect((await repo.groups(ownerId)).find((group) => group.id === groupId)?.counterpartAvatar).not.toHaveProperty('avatarHash');
    expect(await repo.group(groupId, ownerId)).toMatchObject({ counterpartName: 'A Ledger Only', counterpartAvatar: { avatarMode: 'initials' } });
    await repo.updateDisplayName(peerId, 'Saved Peer', 'initials');
    expect((await repo.groups(ownerId)).find((group) => group.id === groupId)?.counterpartAvatar).toEqual({ avatarMode: 'initials' });
  });
});
