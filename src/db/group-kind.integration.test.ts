import { describe, expect, it } from 'vitest';
import { db } from './cloudflare-d1-test';
import { Repository } from './repository';

const unique = (label: string) => `${label}-${crypto.randomUUID()}`;

async function seedNamedGroup(options: { memberCount?: 1 | 2 | 3; genericInvitation?: boolean; genericInvitationState?: 'expired' | 'revoked'; targetedInvitation?: boolean; secondUser?: boolean; softDeletedCounterpart?: boolean } = {}) {
  const groupId = unique('group'), ownerId = unique('owner'), ownerPersonId = unique('owner-person');
  const memberCount = options.memberCount ?? 2;
  const ids = { groupId, ownerId, ownerPersonId, counterpartId: unique('counterpart'), thirdId: unique('third'), secondUserId: unique('second-user'), secondPersonId: unique('second-person') };
  const statements = [
    db.prepare('INSERT INTO users(id,email,created_at,updated_at) VALUES(?,?,?,?)').bind(ownerId, `${ownerId}@example.com`, '2026-01-01', '2026-01-01'),
    db.prepare('INSERT INTO people(id,name,email,user_id,created_at) VALUES(?,?,?,?,?)').bind(ownerPersonId, 'Owner', `${ownerId}@example.com`, ownerId, '2026-01-01'),
    db.prepare('INSERT INTO people(id,name,email,created_at) VALUES(?,?,?,?)').bind(ids.counterpartId, 'Counterpart', `${ids.counterpartId}@example.com`, '2026-01-01'),
    db.prepare('INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES(?,?,?,?,?)').bind(groupId, 'Stored group name', 'USD', '2026-01-01', '2026-01-01'),
    db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES(?,?,?,?, 'owner')").bind(groupId, ownerPersonId, ownerId, '2026-01-01'),
  ];
  if (memberCount >= 2) statements.push(db.prepare("INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES(?,?,?, 'member')").bind(groupId, ids.counterpartId, '2026-01-01'));
  if (memberCount >= 3) {
    statements.push(db.prepare('INSERT INTO people(id,name,email,created_at) VALUES(?,?,?,?)').bind(ids.thirdId, 'Third', `${ids.thirdId}@example.com`, '2026-01-01'));
    statements.push(db.prepare("INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES(?,?,?, 'member')").bind(groupId, ids.thirdId, '2026-01-01'));
  }
  if (options.secondUser) {
    statements.push(db.prepare('INSERT INTO users(id,email,created_at,updated_at) VALUES(?,?,?,?)').bind(ids.secondUserId, `${ids.secondUserId}@example.com`, '2026-01-01', '2026-01-01'));
    statements.push(db.prepare('INSERT INTO people(id,name,email,user_id,created_at) VALUES(?,?,?,?,?)').bind(ids.secondPersonId, 'Member', `${ids.secondUserId}@example.com`, ids.secondUserId, '2026-01-01'));
    statements.push(db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES(?,?,?,?, 'member')").bind(groupId, ids.secondPersonId, ids.secondUserId, '2026-01-01'));
  }
  if (options.softDeletedCounterpart) statements.push(db.prepare('UPDATE people SET deleted_at=? WHERE id=?').bind('2026-01-02', ids.counterpartId));
  if (options.genericInvitation || options.genericInvitationState) {
    const state = options.genericInvitationState;
    statements.push(db.prepare('INSERT INTO group_invitations(id,group_id,email_normalized,created_by,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?)').bind(unique('generic'), groupId, 'generic@example.com', ownerId, '2026-01-01', state === 'expired' ? '2000-01-01' : '9999-01-01', state === 'revoked' ? '2026-01-02' : null));
  }
  if (options.targetedInvitation) statements.push(db.prepare('INSERT INTO group_invitations(id,group_id,email_normalized,created_by,created_at,expires_at,target_person_id) VALUES(?,?,?,?,?,?,?)').bind(unique('targeted'), groupId, 'counterpart@example.com', ownerId, '2026-01-01', '9999-01-01', ids.counterpartId));
  await db.batch(statements);
  return ids;
}

describe('named and peer group conversion', () => {
  it('converts an eligible named group, retains its stored name and ledger rows, and converts back', async () => {
    const { groupId, ownerId, ownerPersonId, counterpartId } = await seedNamedGroup();
    const expenseId = unique('expense');
    await db.batch([
      db.prepare("INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,1)").bind(expenseId, groupId, 'Dinner', 1200, 'USD', '2026-01-02', ownerId, '2026-01-02', '2026-01-02'),
      db.prepare('INSERT INTO payers(expense_id,person_id,amount_minor) VALUES(?,?,?)').bind(expenseId, ownerPersonId, 1200),
      db.prepare('INSERT INTO splits(expense_id,person_id,amount_minor) VALUES(?,?,?)').bind(expenseId, counterpartId, 600),
    ]);
    const repository = new Repository(db as never);
    await expect(repository.convertNamedToPeer(groupId, ownerId)).resolves.toMatchObject({ kind: 'peer', name: 'Stored group name', counterpartName: 'Counterpart' });
    await expect(repository.convertPeerToNamed(groupId, ownerId, 'Restored name')).resolves.toMatchObject({ kind: 'named', name: 'Restored name' });
    await expect(db.prepare('SELECT kind,name FROM groups WHERE id=?').bind(groupId).first()).resolves.toEqual({ kind: 'named', name: 'Restored name' });
    await expect(db.prepare('SELECT description,amount_minor FROM expenses WHERE id=?').bind(expenseId).first()).resolves.toEqual({ description: 'Dinner', amount_minor: 1200 });
  });

  it('makes conversion idempotent for the active owner', async () => {
    const { groupId, ownerId } = await seedNamedGroup();
    const repository = new Repository(db as never);
    await repository.convertNamedToPeer(groupId, ownerId);
    await expect(repository.convertNamedToPeer(groupId, ownerId)).resolves.toMatchObject({ kind: 'peer' });
  });

  it('rejects unauthorized conversion and every ineligible active-member count', async () => {
    const unauthorized = await seedNamedGroup({ secondUser: true });
    await expect(new Repository(db as never).convertNamedToPeer(unauthorized.groupId, unauthorized.secondUserId)).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    for (const memberCount of [1, 3] as const) {
      const ids = await seedNamedGroup({ memberCount });
      await expect(new Repository(db as never).convertNamedToPeer(ids.groupId, ids.ownerId)).rejects.toMatchObject({ code: 'PEER_LIMIT', message: 'A peer relationship requires exactly two active ledger participants' });
      await expect(db.prepare('SELECT kind FROM groups WHERE id=?').bind(ids.groupId).first()).resolves.toEqual({ kind: 'named' });
    }
  });

  it('rejects pending generic invitations but permits the targeted counterpart invitation', async () => {
    const blocked = await seedNamedGroup({ genericInvitation: true });
    await expect(new Repository(db as never).convertNamedToPeer(blocked.groupId, blocked.ownerId)).rejects.toMatchObject({ code: 'PEER_LIMIT', message: 'Revoke pending generic group invitations before converting to a peer relationship' });
    await expect(db.prepare('SELECT revoked_at FROM group_invitations WHERE group_id=?').bind(blocked.groupId).first()).resolves.toEqual({ revoked_at: null });
    const targeted = await seedNamedGroup({ targetedInvitation: true });
    await expect(new Repository(db as never).convertNamedToPeer(targeted.groupId, targeted.ownerId)).resolves.toMatchObject({ kind: 'peer' });
    await expect(db.prepare('SELECT target_person_id,revoked_at FROM group_invitations WHERE group_id=?').bind(targeted.groupId).first()).resolves.toMatchObject({ target_person_id: targeted.counterpartId, revoked_at: null });
  });

  it('blocks invitation retargeting and terminal/expired generic invitation reactivation on a peer', async () => {
    const targeted = await seedNamedGroup({ targetedInvitation: true });
    const repository = new Repository(db as never);
    await repository.convertNamedToPeer(targeted.groupId, targeted.ownerId);
    await expect(db.prepare('UPDATE group_invitations SET target_person_id=NULL WHERE group_id=?').bind(targeted.groupId).run()).rejects.toThrow(/PEER_LIMIT/);
    await expect(db.prepare('SELECT target_person_id FROM group_invitations WHERE group_id=?').bind(targeted.groupId).first()).resolves.toMatchObject({ target_person_id: targeted.counterpartId });

    const expired = await seedNamedGroup({ genericInvitationState: 'expired' });
    await repository.convertNamedToPeer(expired.groupId, expired.ownerId);
    await expect(db.prepare("UPDATE group_invitations SET expires_at='9999-01-01' WHERE group_id=?").bind(expired.groupId).run()).rejects.toThrow(/PEER_LIMIT/);

    const retargeted = await seedNamedGroup({ genericInvitationState: 'expired' });
    await repository.convertNamedToPeer(retargeted.groupId, retargeted.ownerId);
    const unrelatedId = unique('unrelated');
    await db.prepare('INSERT INTO people(id,name,created_at) VALUES(?,?,?)').bind(unrelatedId, 'Unrelated', '2026-01-01').run();
    await expect(db.prepare("UPDATE group_invitations SET target_person_id=?,expires_at='9999-01-01' WHERE group_id=?").bind(unrelatedId, retargeted.groupId).run()).rejects.toThrow(/PEER_LIMIT/);
    await expect(db.prepare('SELECT target_person_id,expires_at FROM group_invitations WHERE group_id=?').bind(retargeted.groupId).first()).resolves.toMatchObject({ target_person_id: null, expires_at: '2000-01-01' });
    await expect(db.prepare("UPDATE group_invitations SET target_person_id=?,expires_at='9999-01-01' WHERE group_id=?").bind(retargeted.ownerPersonId, retargeted.groupId).run()).rejects.toThrow(/INVITATION_TARGET_ACCOUNT_MISMATCH/);
    await expect(db.prepare("UPDATE group_invitations SET target_person_id=?,expires_at='9999-01-01' WHERE group_id=?").bind(retargeted.counterpartId, retargeted.groupId).run()).resolves.toBeDefined();
    await db.prepare('UPDATE people SET deleted_at=? WHERE id=?').bind('2026-01-02', retargeted.counterpartId).run();
    await expect(db.prepare("UPDATE group_invitations SET expires_at='9999-01-02' WHERE group_id=?").bind(retargeted.groupId).run()).rejects.toThrow(/PEER_LIMIT/);

    const revoked = await seedNamedGroup({ genericInvitationState: 'revoked' });
    await repository.convertNamedToPeer(revoked.groupId, revoked.ownerId);
    await expect(db.prepare('UPDATE group_invitations SET revoked_at=NULL WHERE group_id=?').bind(revoked.groupId).run()).rejects.toThrow(/PEER_LIMIT/);
  });

  it('uses the same active-person predicate for soft-deleted memberships and rolls back a rejected kind update', async () => {
    const ids = await seedNamedGroup({ softDeletedCounterpart: true });
    const repository = new Repository(db as never);
    await expect(repository.convertNamedToPeer(ids.groupId, ids.ownerId)).rejects.toMatchObject({ code: 'PEER_LIMIT', message: 'A peer relationship requires exactly two active ledger participants' });
    await expect(db.prepare("UPDATE groups SET kind='peer' WHERE id=?").bind(ids.groupId).run()).rejects.toThrow(/PEER_LIMIT/);
    await expect(db.prepare('SELECT kind FROM groups WHERE id=?').bind(ids.groupId).first()).resolves.toEqual({ kind: 'named' });
  });

  it('ignores a soft-deleted person for conversion but blocks restoring them into a full peer group', async () => {
    const ids = await seedNamedGroup({ memberCount: 3, softDeletedCounterpart: true });
    const repository = new Repository(db as never);
    await expect(repository.convertNamedToPeer(ids.groupId, ids.ownerId)).resolves.toMatchObject({ kind: 'peer' });
    await expect(db.prepare('UPDATE people SET deleted_at=NULL WHERE id=?').bind(ids.counterpartId).run()).rejects.toThrow(/PEER_LIMIT/);
    await expect(db.prepare('SELECT deleted_at FROM people WHERE id=?').bind(ids.counterpartId).first()).resolves.toMatchObject({ deleted_at: '2026-01-02' });
  });

  it('keeps the peer invariant after conversion for members and generic invitations', async () => {
    const ids = await seedNamedGroup();
    const repository = new Repository(db as never);
    await repository.convertNamedToPeer(ids.groupId, ids.ownerId);
    const thirdId = unique('race-person');
    await db.prepare('INSERT INTO people(id,name,created_at) VALUES(?,?,?)').bind(thirdId, 'Race third', '2026-01-01').run();
    await expect(db.prepare("INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES(?,?,?, 'member')").bind(ids.groupId, thirdId, '2026-01-01').run()).rejects.toThrow(/PEER_LIMIT/);
    await expect(db.prepare('INSERT INTO group_invitations(id,group_id,email_normalized,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(unique('race-invite'), ids.groupId, 'race@example.com', ids.ownerId, '2026-01-01', '9999-01-01').run()).rejects.toThrow(/PEER_LIMIT/);
  });
});
