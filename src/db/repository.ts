import type { ExpenseInput, ScheduledExpenseInput, SettlementInput } from '../shared/schemas';
import type { D1Database } from '@cloudflare/workers-types';
import type { Activity, AuditEvent, Expense, Group, GroupBalanceSummary, GroupInvitation, GroupMember, ScheduledExpense, ScheduledExpenseStatus, Settlement } from '../shared/types';
import { checkedMinor } from '../shared/money';
import { firstOccurrenceOnOrAfter, localDateForTimeZone, nextCalendarDate, nextOccurrenceDate, recurrenceDefinition, compareDates } from '../domain/recurrence';
import { generatedExpenseInput } from '../domain/scheduled-expense';
import { invitationExpiry, normalizeEmail } from '../shared/invitations';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
type Row = Record<string, unknown>;

export class RepositoryError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'CONFLICT' | 'DATABASE_ERROR' | 'BALANCE_OVERFLOW' | 'SELF_FRIEND' | 'AUTH_IDENTITY_CONFLICT' | 'OWNER_REQUIRED' | 'FINAL_OWNER' | 'INVITATION_INVALID' | 'INVITATION_EXPIRED' | 'INVITATION_REVOKED' | 'MEMBER_REQUIRED' | 'INVALID_SEARCH' | 'INVALID_CURSOR', message: string) { super(message); }
}
const text = (value: unknown) => String(value ?? '');
const number = (value: unknown) => Number(value ?? 0);
const minor = (value: unknown) => checkedMinor(value);
const currency = (value: unknown) => text(value) as Expense['currency'];
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, nested) => nested && typeof nested === 'object' && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : nested);

export type LedgerCursor = { date: string; createdAt: string; id: string };
const cursorText = (value: LedgerCursor) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
export const encodeLedgerCursor = (value: LedgerCursor) => cursorText(value);
export const decodeLedgerCursor = (value: string | undefined): LedgerCursor | undefined => {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error('invalid cursor');
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<LedgerCursor>;
    if (typeof parsed.date !== 'string' || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string' || !parsed.id) throw new Error('invalid cursor');
    return { date: parsed.date, createdAt: parsed.createdAt, id: parsed.id };
  } catch { throw new RepositoryError('INVALID_CURSOR', 'The pagination cursor is invalid'); }
};
export const assertLikeSearch = (value: string | undefined) => {
  if (value === undefined) return;
  // D1's LIKE pattern limit applies to the complete pattern, including the
  // wildcards added by the repository.
  if (new TextEncoder().encode(`%${value}%`).byteLength > 50) throw new RepositoryError('INVALID_SEARCH', 'Search text must be at most 48 UTF-8 bytes');
};

type ExportCursor = { groupId: string; expenseCursor?: string | null; settlementCursor?: string | null };
const encodeExportCursor = (value: ExportCursor) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const decodeExportCursor = (value: string): ExportCursor => {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new Error('invalid cursor');
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)))) as Partial<ExportCursor>;
    if (typeof parsed.groupId !== 'string' || !parsed.groupId || (parsed.expenseCursor !== undefined && parsed.expenseCursor !== null && typeof parsed.expenseCursor !== 'string') || (parsed.settlementCursor !== undefined && parsed.settlementCursor !== null && typeof parsed.settlementCursor !== 'string')) throw new Error('invalid cursor');
    return { groupId: parsed.groupId, expenseCursor: parsed.expenseCursor, settlementCursor: parsed.settlementCursor };
  } catch { throw new RepositoryError('INVALID_CURSOR', 'The export pagination cursor is invalid'); }
};

function mapGroup(row: Row | null): Group | null {
  if (!row) return null;
  const balanceSummaries = row.balance_summaries == null ? undefined : (() => {
    try {
      const parsed = typeof row.balance_summaries === 'string' ? JSON.parse(row.balance_summaries) : row.balance_summaries;
      if (!Array.isArray(parsed)) return undefined;
      return parsed.map((item) => {
        const value = item as { currency?: unknown; net_minor?: unknown };
        return { currency: currency(value.currency), netMinor: minor(value.net_minor) } as GroupBalanceSummary;
      });
    } catch {
      return undefined;
    }
  })();
  return {
    id: text(row.id), name: text(row.name), currency: currency(row.currency), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
    ...(row.role ? { role: text(row.role) as Group['role'] } : {}),
    ...(row.member_count == null ? {} : { memberCount: number(row.member_count) }),
    ...(row.counterpart_name == null ? {} : { counterpartName: text(row.counterpart_name) }),
    ...(balanceSummaries === undefined ? {} : { balanceSummaries }),
  };
}

const groupSelect = (requestedGroup = false) => `WITH authorized_groups AS (
    SELECT DISTINCT gm.group_id,gm.person_id,gm.role
    FROM group_members gm JOIN groups authorized_group ON authorized_group.id=gm.group_id
    WHERE gm.user_id=? AND gm.deleted_at IS NULL AND authorized_group.deleted_at IS NULL${requestedGroup ? ' AND gm.group_id=?' : ''}
  ), scoped_groups AS (
    SELECT DISTINCT group_id FROM authorized_groups
   ), ledger AS (
     SELECT projection.group_id,projection.currency,projection.person_id,projection.net_minor
     FROM group_balance_projection projection JOIN scoped_groups scope ON scope.group_id=projection.group_id
     JOIN projection_state ready_projection ON ready_projection.group_id=projection.group_id AND ready_projection.status='ready'
     UNION ALL
     -- Transitional fallback: a missing or non-ready projection never hides
     -- the old authoritative ledger aggregate.
     SELECT e.group_id,e.currency,p.person_id,p.amount_minor AS net_minor
     FROM expenses e JOIN scoped_groups scope ON scope.group_id=e.group_id JOIN payers p ON p.expense_id=e.id
     WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=e.group_id AND state.status='ready')
     UNION ALL
     SELECT e.group_id,e.currency,s.person_id,-s.amount_minor AS net_minor
     FROM expenses e JOIN scoped_groups scope ON scope.group_id=e.group_id JOIN splits s ON s.expense_id=e.id
     WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=e.group_id AND state.status='ready')
     UNION ALL
     SELECT s.group_id,s.currency,s.from_person_id AS person_id,s.amount_minor AS net_minor
     FROM settlements s JOIN scoped_groups scope ON scope.group_id=s.group_id
     WHERE s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=s.group_id AND state.status='ready')
     UNION ALL
     SELECT s.group_id,s.currency,s.to_person_id AS person_id,-s.amount_minor AS net_minor
     FROM settlements s JOIN scoped_groups scope ON scope.group_id=s.group_id
     WHERE s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=s.group_id AND state.status='ready')
  ), group_balances AS (
     SELECT ledger.group_id,ledger.currency,SUM(ledger.net_minor) AS net_minor
      FROM ledger JOIN authorized_groups balance_member ON balance_member.group_id=ledger.group_id
       AND balance_member.person_id=ledger.person_id
    GROUP BY ledger.group_id,ledger.currency
    HAVING SUM(ledger.net_minor) <> 0
  ), ranked_balances AS (
    SELECT group_id,currency,net_minor,
      ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY ABS(net_minor) DESC,currency ASC) AS balance_rank
    FROM group_balances
  ), balance_json AS (
    SELECT group_id,json_group_array(json_object('currency',currency,'net_minor',net_minor)) AS balance_summaries
    FROM (SELECT group_id,currency,net_minor FROM ranked_balances WHERE balance_rank <= 2 ORDER BY group_id,balance_rank)
    GROUP BY group_id
  )
  SELECT g.*,gm.role,
  (SELECT COUNT(*) FROM group_members member_count WHERE member_count.group_id=g.id AND member_count.deleted_at IS NULL) AS member_count,
  (SELECT p.name FROM people p JOIN group_members other_member ON other_member.person_id=p.id
    WHERE other_member.group_id=g.id AND other_member.person_id != gm.person_id AND other_member.deleted_at IS NULL AND p.deleted_at IS NULL
     ORDER BY p.name LIMIT 1) AS counterpart_name,
  COALESCE(balance_json.balance_summaries, '[]') AS balance_summaries
  FROM groups g JOIN authorized_groups gm ON gm.group_id=g.id
  LEFT JOIN balance_json ON balance_json.group_id=g.id`;

const authorizedGroupSelect = `SELECT g.*,gm.role,
  (SELECT COUNT(*) FROM group_members member_count WHERE member_count.group_id=g.id AND member_count.deleted_at IS NULL) AS member_count,
  (SELECT p.name FROM people p JOIN group_members other_member ON other_member.person_id=p.id
    WHERE other_member.group_id=g.id AND other_member.person_id != gm.person_id AND other_member.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY p.name LIMIT 1) AS counterpart_name
  FROM groups g JOIN group_members gm ON gm.group_id=g.id
  WHERE g.id=? AND g.deleted_at IS NULL AND gm.user_id=? AND gm.deleted_at IS NULL`;

export class Repository {
  constructor(private readonly db: D1Database) {}

  /**
   * Recompute one group's compact read model inside the caller's D1 batch.
   * Recompute (rather than incremental arithmetic) makes edits that change a
   * currency or participant set naturally correct and keeps concurrent writes
   * race-safe: D1 serializes the transaction and the SELECT observes the
   * preceding statements in that transaction.
   */
  private projectionStatements(groupId: string, timestamp = now(), finalize = false) {
    const readiness = finalize
      ? this.db.prepare(`INSERT INTO projection_state(group_id,status,backfill_cursor,last_rebuilt_at,updated_at)
          VALUES(?,'ready',NULL,?,?) ON CONFLICT(group_id) DO UPDATE SET status='ready',backfill_cursor=NULL,last_rebuilt_at=excluded.last_rebuilt_at,updated_at=excluded.updated_at`).bind(groupId, timestamp, timestamp)
      : this.db.prepare(`INSERT INTO projection_state(group_id,status,backfill_cursor,last_rebuilt_at,updated_at)
          VALUES(?,'pending',NULL,NULL,?) ON CONFLICT(group_id) DO UPDATE SET updated_at=excluded.updated_at`).bind(groupId, timestamp);
    return [
      this.db.prepare('DELETE FROM ledger_totals WHERE group_id=?').bind(groupId),
      this.db.prepare('DELETE FROM group_balance_projection WHERE group_id=?').bind(groupId),
      this.db.prepare(`INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at)
        SELECT group_id,currency,SUM(amount_minor),? FROM (
          SELECT group_id,currency,amount_minor FROM expenses WHERE group_id=? AND deleted_at IS NULL
          UNION ALL SELECT group_id,currency,amount_minor FROM settlements WHERE group_id=? AND deleted_at IS NULL
        ) GROUP BY group_id,currency`).bind(timestamp, groupId, groupId),
      this.db.prepare(`INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at)
        SELECT group_id,currency,person_id,SUM(net_minor),? FROM (
          SELECT e.group_id,e.currency,p.person_id,p.amount_minor AS net_minor
          FROM expenses e JOIN payers p ON p.expense_id=e.id WHERE e.group_id=? AND e.deleted_at IS NULL
          UNION ALL SELECT e.group_id,e.currency,s.person_id,-s.amount_minor
          FROM expenses e JOIN splits s ON s.expense_id=e.id WHERE e.group_id=? AND e.deleted_at IS NULL
          UNION ALL SELECT group_id,currency,from_person_id,amount_minor FROM settlements WHERE group_id=? AND deleted_at IS NULL
          UNION ALL SELECT group_id,currency,to_person_id,-amount_minor FROM settlements WHERE group_id=? AND deleted_at IS NULL
        ) GROUP BY group_id,currency,person_id HAVING SUM(net_minor)<>0`).bind(timestamp, groupId, groupId, groupId, groupId),
      readiness,
    ];
  }

  private async rebuildProjection(groupId: string) {
    try { await this.db.batch(this.projectionStatements(groupId, now(), true)); }
    catch (error) { if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow(); throw error; }
  }

  async projectionBackfill(options: { maxGroups?: number } = {}) {
    const maxGroups = Math.min(Math.max(options.maxGroups ?? 2, 1), 10);
    const rows = (await this.db.prepare(`SELECT g.id FROM groups g LEFT JOIN projection_state state ON state.group_id=g.id
      WHERE g.deleted_at IS NULL AND (state.group_id IS NULL OR state.status<>'ready') ORDER BY g.id LIMIT ?`).bind(maxGroups).all<Row>()).results;
    let rebuilt = 0;
    // Each group is one bounded atomic unit.  If Cron is interrupted, the
    // batch rolls back and the same state is safely selected on the next tick.
    for (const row of rows) {
      const groupId = text(row.id), timestamp = now();
      try {
        await this.db.batch([
          this.db.prepare(`INSERT INTO projection_state(group_id,status,backfill_cursor,updated_at)
            VALUES(?,'backfilling',?,?) ON CONFLICT(group_id) DO UPDATE SET status='backfilling',backfill_cursor=excluded.backfill_cursor,updated_at=excluded.updated_at`).bind(groupId, groupId, timestamp),
          ...this.projectionStatements(groupId, timestamp, true),
        ]);
        rebuilt += 1;
      } catch (error) {
        if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow();
        throw error;
      }
    }
    return { groupsScanned: rows.length, groupsRebuilt: rebuilt, capped: rows.length >= maxGroups };
  }

  async balanceProjection(groupId: string) {
    const state = await this.db.prepare('SELECT status FROM projection_state WHERE group_id=?').bind(groupId).first<Row>();
    const ready = text(state?.status) === 'ready';
    const source = ready
      ? 'SELECT currency,person_id,net_minor FROM group_balance_projection WHERE group_id=? ORDER BY currency,person_id'
      : `SELECT currency,person_id,SUM(net_minor) AS net_minor FROM (
          SELECT e.currency,p.person_id,p.amount_minor AS net_minor FROM expenses e JOIN payers p ON p.expense_id=e.id WHERE e.group_id=? AND e.deleted_at IS NULL
          UNION ALL SELECT e.currency,s.person_id,-s.amount_minor FROM expenses e JOIN splits s ON s.expense_id=e.id WHERE e.group_id=? AND e.deleted_at IS NULL
          UNION ALL SELECT currency,from_person_id,amount_minor FROM settlements WHERE group_id=? AND deleted_at IS NULL
          UNION ALL SELECT currency,to_person_id,-amount_minor FROM settlements WHERE group_id=? AND deleted_at IS NULL
        ) GROUP BY currency,person_id HAVING SUM(net_minor)<>0 ORDER BY currency,person_id`;
    const args = ready ? [groupId] : [groupId, groupId, groupId, groupId];
    const rows = (await this.db.prepare(source).bind(...args).all<Row>()).results;
    return { ready, rows: rows.map((row) => ({ currency: currency(row.currency), personId: text(row.person_id), netMinor: minor(row.net_minor) })) };
  }

  private async personForUser(user: Row, email: string, t = now()) {
    let person = await this.db.prepare('SELECT * FROM people WHERE user_id=? AND deleted_at IS NULL').bind(user.id).first<Row>();
    if (!person) {
      const candidate = await this.db.prepare('SELECT * FROM people WHERE lower(email)=? AND deleted_at IS NULL').bind(email).first<Row>();
      if (candidate && (candidate.user_id == null || String(candidate.user_id) === String(user.id))) {
        await this.db.prepare('UPDATE people SET user_id=? WHERE id=? AND user_id IS NULL').bind(user.id, candidate.id).run();
        person = { ...candidate, user_id: user.id };
      } else {
        const id = uid();
        // A pre-existing person with this email may belong to another identity.
        // Keep the new identity unambiguous rather than linking accounts.
        try {
          await this.db.prepare('INSERT INTO people(id,name,email,user_id,created_at) VALUES(?,?,?,?,?)').bind(id, email.split('@')[0], candidate ? null : email, user.id, t).run();
          person = { id, name: email.split('@')[0], email: candidate ? null : email, user_id: user.id, created_at: t };
        } catch (error) {
          if (!(error instanceof Error) || !/unique|constraint/i.test(error.message)) throw error;
          const winner = await this.db.prepare('SELECT * FROM people WHERE lower(email)=? AND deleted_at IS NULL').bind(email).first<Row>();
          if (winner && winner.user_id == null) {
            await this.db.prepare('UPDATE people SET user_id=? WHERE id=? AND user_id IS NULL').bind(user.id, winner.id).run();
            person = { ...winner, user_id: user.id };
          } else if (winner && String(winner.user_id) === String(user.id)) {
            person = winner;
          } else {
            await this.db.prepare('INSERT INTO people(id,name,email,user_id,created_at) VALUES(?,?,?,?,?)').bind(id, email.split('@')[0], null, user.id, t).run();
            person = { id, name: email.split('@')[0], email: null, user_id: user.id, created_at: t };
          }
        }
      }
    }
     // Linking a person to an authenticated identity is not group consent.
     // In particular, legacy ledger-only memberships keep user_id NULL until
     // the person accepts an invitation.
     return { user, person };
  }

  async user(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    const t = now();
    await this.db.prepare('INSERT OR IGNORE INTO users(id,email,created_at,updated_at) VALUES(?,?,?,?)').bind(uid(), email, t, t).run();
    const user = await this.db.prepare('SELECT * FROM users WHERE email=?').bind(email).first<Row>();
    if (!user) throw new RepositoryError('DATABASE_ERROR', 'Unable to create user');
    return this.personForUser(user, email, t);
  }
  async me(email: string) { return this.user(email); }

  /**
   * Resolve a verified Clerk session without changing the application's
   * existing user/person IDs. The Clerk ID is authoritative after the first
   * successful link; the email is used only for that initial link.
   */
  async userForClerk(clerkUserId: string, rawEmail: string) {
    const clerkId = clerkUserId.trim();
    const email = rawEmail.trim().toLowerCase();
    if (!clerkId || !email) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'The verified Clerk identity could not be linked safely');

    const mapped = await this.db.prepare('SELECT * FROM users WHERE clerk_user_id=?').bind(clerkId).first<Row>();
    if (mapped) return this.personForUser(mapped, text(mapped.email).toLowerCase());

    const byEmail = await this.db.prepare('SELECT * FROM users WHERE lower(email)=?').bind(email).first<Row>();
    if (byEmail?.clerk_user_id != null && String(byEmail.clerk_user_id) !== clerkId) {
      throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This email is already linked to another Clerk identity');
    }

    const t = now();
    if (byEmail) {
      try {
        // D1 batches are atomic. The conditional predicate makes a concurrent
        // first-link loser observable when the mapping is read back below.
        await this.db.batch([this.db.prepare('UPDATE users SET clerk_user_id=?,updated_at=? WHERE id=? AND clerk_user_id IS NULL').bind(clerkId, t, byEmail.id)]);
      } catch (error) {
        if (!Repository.isUnique(error)) throw error;
      }
      const linked = await this.db.prepare('SELECT * FROM users WHERE id=?').bind(byEmail.id).first<Row>();
      if (!linked || String(linked.clerk_user_id) !== clerkId) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'The existing email mapping changed; the Clerk identity was not linked');
      return this.personForUser(linked, text(linked.email).toLowerCase(), t);
    }

    const id = uid();
    try {
      await this.db.batch([this.db.prepare('INSERT INTO users(id,email,clerk_user_id,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id, email, clerkId, t, t)]);
    } catch (error) {
      if (!Repository.isUnique(error)) throw error;
      const winner = await this.db.prepare('SELECT * FROM users WHERE clerk_user_id=?').bind(clerkId).first<Row>();
      if (winner) return this.personForUser(winner, text(winner.email).toLowerCase(), t);
      throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'The email mapping changed; the Clerk identity was not linked');
    }
    const created = await this.db.prepare('SELECT * FROM users WHERE id=?').bind(id).first<Row>();
    if (!created || String(created.clerk_user_id) !== clerkId) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'The Clerk identity was not linked safely');
    return this.personForUser(created, email, t);
  }

  async groups(userId: string): Promise<Group[]> {
    const rows = (await this.db.prepare(`${groupSelect()} WHERE g.deleted_at IS NULL ORDER BY g.created_at DESC`).bind(userId).all<Row>()).results;
    return rows.map((row) => mapGroup(row)!).filter(Boolean);
  }
  async group(groupId: string, userId: string): Promise<Group | null> {
    return mapGroup(await this.db.prepare(authorizedGroupSelect).bind(groupId, userId).first<Row>());
  }
  async membership(groupId: string, userId: string): Promise<'owner' | 'member' | null> {
    const row = await this.db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=? AND deleted_at IS NULL').bind(groupId, userId).first<Row>();
    return row ? (text(row.role) === 'owner' ? 'owner' : 'member') : null;
  }
  async members(groupId: string): Promise<GroupMember[]> {
    const rows = (await this.db.prepare('SELECT p.id AS person_id,p.name,p.email,gm.joined_at,gm.role FROM people p JOIN group_members gm ON gm.person_id=p.id WHERE gm.group_id=? AND gm.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY p.name').bind(groupId).all<Row>()).results;
    return rows.map((row) => ({ personId: text(row.person_id), name: text(row.name), email: row.email == null ? null : text(row.email), joinedAt: text(row.joined_at), role: text(row.role) === 'owner' ? 'owner' : 'member' }));
  }
  async allMembers(groupId: string): Promise<GroupMember[]> {
    const rows = (await this.db.prepare('SELECT p.id AS person_id,p.name,p.email,gm.joined_at,gm.role FROM people p JOIN group_members gm ON gm.person_id=p.id WHERE gm.group_id=? AND p.deleted_at IS NULL ORDER BY p.name').bind(groupId).all<Row>()).results;
    return rows.map((row) => ({ personId: text(row.person_id), name: text(row.name), email: row.email == null ? null : text(row.email), joinedAt: text(row.joined_at), role: text(row.role) === 'owner' ? 'owner' : 'member' }));
  }
  async groupPeople(groupId: string): Promise<string[]> {
    const rows = (await this.db.prepare('SELECT gm.person_id FROM people p JOIN group_members gm ON gm.person_id=p.id WHERE gm.group_id=?').bind(groupId).all<Row>()).results;
    return rows.map((row) => text(row.person_id));
  }
  private mapInvitation(row: Row): GroupInvitation {
    return { id: text(row.id), groupId: text(row.group_id), email: text(row.email_normalized), createdBy: text(row.created_by), createdAt: text(row.created_at), expiresAt: text(row.expires_at), revokedAt: row.revoked_at == null ? null : text(row.revoked_at), acceptedAt: row.accepted_at == null ? null : text(row.accepted_at), acceptedBy: row.accepted_by == null ? null : text(row.accepted_by), rejectedAt: row.rejected_at == null ? null : text(row.rejected_at) };
  }
  async invitationsForOwner(groupId: string): Promise<GroupInvitation[]> {
    return (await this.db.prepare('SELECT * FROM group_invitations WHERE group_id=? ORDER BY created_at DESC').bind(groupId).all<Row>()).results.map((row) => this.mapInvitation(row));
  }
  async invitationsForUser(userId: string): Promise<GroupInvitation[]> {
    const user = await this.db.prepare('SELECT email FROM users WHERE id=?').bind(userId).first<Row>();
    if (!user) return [];
    return (await this.db.prepare("SELECT * FROM group_invitations WHERE email_normalized=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND expires_at>? AND EXISTS (SELECT 1 FROM groups g WHERE g.id=group_invitations.group_id AND g.deleted_at IS NULL) ORDER BY created_at DESC").bind(normalizeEmail(text(user.email)), now()).all<Row>()).results.map((row) => this.mapInvitation(row));
  }
  async createInvitation(groupId: string, userId: string, email: string): Promise<GroupInvitation> {
    const normalized = normalizeEmail(email), id = uid(), t = now(), expires = invitationExpiry(new Date(t));
    if (!normalized) throw new RepositoryError('INVITATION_INVALID', 'A normalized email is required');
    const activeMember = await this.db.prepare('SELECT 1 FROM group_members gm JOIN people p ON p.id=gm.person_id WHERE gm.group_id=? AND gm.user_id IS NOT NULL AND gm.deleted_at IS NULL AND p.deleted_at IS NULL AND lower(p.email)=?').bind(groupId, normalized).first<Row>();
    if (activeMember) throw new RepositoryError('INVITATION_INVALID', 'That person is already an active group member');
    const existing = await this.db.prepare("SELECT * FROM group_invitations WHERE group_id=? AND email_normalized=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1").bind(groupId, normalized, t).first<Row>();
    if (existing) return this.mapInvitation(existing);
    const result = await this.db.batch([
      this.db.prepare("INSERT INTO group_invitations(id,group_id,email_normalized,created_by,created_at,expires_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM groups g JOIN group_members gm ON gm.group_id=g.id WHERE g.id=? AND g.deleted_at IS NULL AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL)").bind(id, groupId, normalized, userId, t, expires, groupId, userId),
    ]);
    if (result.length && Number((result[0] as { meta?: { changes?: number } }).meta?.changes) === 0) throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can create invitations');
    const created = await this.db.prepare('SELECT * FROM group_invitations WHERE id=?').bind(id).first<Row>();
    if (!created) throw new RepositoryError('DATABASE_ERROR', 'The invitation could not be created');
    return this.mapInvitation(created);
  }
  async revokeInvitation(groupId: string, invitationId: string, userId: string): Promise<boolean> {
    const result = await this.db.prepare("UPDATE group_invitations SET revoked_at=? WHERE id=? AND group_id=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id=? AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL)").bind(now(), invitationId, groupId, groupId, userId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
  async acceptInvitation(invitationId: string, userId: string): Promise<GroupInvitation> {
    const user = await this.db.prepare('SELECT * FROM users WHERE id=?').bind(userId).first<Row>();
    if (!user) throw new RepositoryError('INVITATION_INVALID', 'The authenticated user is not available');
    const email = normalizeEmail(text(user.email)), invitation = await this.db.prepare('SELECT * FROM group_invitations WHERE id=? AND email_normalized=?').bind(invitationId, email).first<Row>();
    if (!invitation) throw new RepositoryError('INVITATION_INVALID', 'Invitation not found for the authenticated email');
    const t = now();
    if (invitation.revoked_at != null) throw new RepositoryError('INVITATION_REVOKED', 'This invitation has been revoked');
    if (invitation.accepted_at != null) return this.mapInvitation(invitation);
    if (invitation.rejected_at != null) throw new RepositoryError('INVITATION_INVALID', 'This invitation was rejected');
    if (text(invitation.expires_at) <= t) throw new RepositoryError('INVITATION_EXPIRED', 'This invitation has expired');
    const groupId = text(invitation.group_id);
    const groupPerson = await this.db.prepare('SELECT p.* FROM people p JOIN group_members gm ON gm.person_id=p.id WHERE gm.group_id=? AND lower(p.email)=? AND p.deleted_at IS NULL').bind(groupId, email).first<Row>();
    const linkedPerson = groupPerson ?? await this.db.prepare('SELECT * FROM people WHERE lower(email)=? AND user_id=? AND deleted_at IS NULL').bind(email, userId).first<Row>();
    const personId = text(linkedPerson?.id || uid()), statements = [
      this.db.prepare("UPDATE group_invitations SET accepted_at=?,accepted_by=? WHERE id=? AND email_normalized=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND expires_at>? AND EXISTS (SELECT 1 FROM groups WHERE id=? AND deleted_at IS NULL)").bind(t, userId, invitationId, email, t, groupId),
      ...(linkedPerson ? [] : [this.db.prepare("INSERT INTO people(id,name,email,user_id,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND accepted_by=? AND accepted_at IS NOT NULL)").bind(personId, email.split('@')[0], email, userId, t, invitationId, userId)]),
      this.db.prepare("UPDATE group_members SET user_id=?,deleted_at=NULL,role='member' WHERE group_id=? AND person_id=? AND EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND accepted_by=? AND accepted_at IS NOT NULL)").bind(userId, groupId, personId, invitationId, userId),
      this.db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) SELECT ?,?,?,?,'member' WHERE EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND accepted_by=? AND accepted_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM group_members WHERE group_id=? AND person_id=? )").bind(groupId, personId, userId, t, invitationId, userId, groupId, personId),
    ];
    const result = await this.db.batch(statements);
    if (Number((result[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) throw new RepositoryError('CONFLICT', 'The invitation changed before it could be accepted');
    const accepted = await this.db.prepare('SELECT * FROM group_invitations WHERE id=?').bind(invitationId).first<Row>();
    if (!accepted) throw new RepositoryError('DATABASE_ERROR', 'The accepted invitation could not be read');
    return this.mapInvitation(accepted);
  }
  async rejectInvitation(invitationId: string, userId: string): Promise<boolean> {
    const user = await this.db.prepare('SELECT email FROM users WHERE id=?').bind(userId).first<Row>();
    if (!user) return false;
    const result = await this.db.prepare("UPDATE group_invitations SET rejected_at=? WHERE id=? AND email_normalized=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND expires_at>?").bind(now(), invitationId, normalizeEmail(text(user.email)), now()).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
  async removeMember(groupId: string, personId: string, userId: string): Promise<boolean> {
    const timestamp = now();
    const result = await this.db.batch([
      this.db.prepare("UPDATE group_members SET deleted_at=? WHERE group_id=? AND person_id=? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM groups g WHERE g.id=? AND g.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM group_members actor WHERE actor.group_id=? AND actor.user_id=? AND actor.role='owner' AND actor.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM group_members self WHERE self.group_id=? AND self.person_id=? AND self.user_id=?) AND (role!='owner' OR (SELECT COUNT(*) FROM group_members owners WHERE owners.group_id=? AND owners.role='owner' AND owners.deleted_at IS NULL)>1)").bind(timestamp, groupId, personId, groupId, groupId, userId, groupId, personId, userId, groupId),
      this.db.prepare("UPDATE group_invitations SET revoked_at=? WHERE group_id=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND email_normalized=(SELECT lower(p.email) FROM people p WHERE p.id=? AND p.email IS NOT NULL)").bind(timestamp, groupId, personId),
    ]);
    const memberChanges = Number((result[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
    if (memberChanges === 0) {
      const selfRemoval = await this.db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND person_id=? AND user_id=? AND deleted_at IS NULL').bind(groupId, personId, userId).first<Row>();
      if (selfRemoval) throw new RepositoryError('MEMBER_REQUIRED', 'An owner cannot remove their own membership');
      const target = await this.db.prepare('SELECT role,deleted_at FROM group_members WHERE group_id=? AND person_id=?').bind(groupId, personId).first<Row>();
      if (target?.role === 'owner' && target.deleted_at == null) throw new RepositoryError('FINAL_OWNER', 'The final active owner cannot be removed');
      throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can remove members');
    }
    return true;
  }
  async createGroup(userId: string, personId: string, input: { name: string; currency: string }) {
    const id = uid(), t = now();
    await this.db.batch([
      this.db.prepare('INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id, input.name, input.currency, t, t),
      this.db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES(?,?,?,?, 'owner')").bind(id, personId, userId, t),
      this.db.prepare("INSERT INTO projection_state(group_id,status,backfill_cursor,last_rebuilt_at,updated_at) VALUES(?,'ready',NULL,?,?)").bind(id, t, t),
    ]);
    return this.group(id, userId);
  }
  async createFriend(userId: string, personId: string, input: { name: string; email?: string | null; currency: string; client_operation_id?: string }) {
    const name = input.name.trim(), email = input.email?.trim().toLowerCase() || null;
    const linkedUser = email ? await this.db.prepare('SELECT email FROM users WHERE id=?').bind(userId).first<Row>() : null;
    const creator = await this.db.prepare('SELECT * FROM people WHERE id=? AND deleted_at IS NULL').bind(personId).first<Row>();
    if (email && (text(linkedUser?.email).toLowerCase() === email || text(creator?.email).toLowerCase() === email)) throw new RepositoryError('SELF_FRIEND', 'You cannot add your own linked person as a friend');

    const operationId = input.client_operation_id;
    const hash = stableJson({ ...input, name, email });
    if (operationId) {
      const existingClaim = await this.db.prepare('SELECT * FROM idempotency_keys WHERE kind=? AND user_id=? AND operation_id=?').bind('friend.create', userId, operationId).first<Row>();
      if (existingClaim) {
        if (text(existingClaim.request_hash) !== hash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
        const original = await this.group(text(existingClaim.entity_id), userId);
        if (original) return original;
        throw new RepositoryError('DATABASE_ERROR', 'Idempotency result is unavailable');
      }
    }

    let existing = email ? await this.db.prepare('SELECT * FROM people WHERE lower(email)=? AND deleted_at IS NULL').bind(email).first<Row>() : null;
    if (existing && (text(existing.id) === personId || text(existing.user_id) === userId)) throw new RepositoryError('SELF_FRIEND', 'You cannot add your own linked person as a friend');
    const id = uid(), friendId = uid(), t = now();
    const create = async (target: Row | null) => {
      const targetPersonId = target ? text(target.id) : friendId;
      const targetUserId = target?.user_id == null ? null : text(target.user_id);
      const statements = [
        ...(target ? [] : [this.db.prepare('INSERT INTO people(id,name,email,created_at) VALUES(?,?,?,?)').bind(friendId, name, email, t)]),
        this.db.prepare('INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id, `With ${name}`, input.currency, t, t),
        this.db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES(?,?,?,?, 'owner')").bind(id, personId, userId, t),
        this.db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES(?,?,?,?, 'member')").bind(id, targetPersonId, targetUserId, t),
        ...(operationId ? [this.db.prepare('INSERT INTO idempotency_keys(kind,user_id,group_id,operation_id,request_hash,entity_id,created_at) VALUES(?,?,?,?,?,?,?)').bind('friend.create', userId, id, operationId, hash, id, t)] : []),
      ];
      await this.db.batch(statements);
    };
    try {
      await create(existing);
    } catch (error) {
      const unique = Repository.isUnique(error);
      if (operationId && unique) {
        const winner = await this.db.prepare('SELECT * FROM idempotency_keys WHERE kind=? AND user_id=? AND operation_id=?').bind('friend.create', userId, operationId).first<Row>();
        if (winner) {
          if (text(winner.request_hash) !== hash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
          const original = await this.group(text(winner.entity_id), userId);
          if (original) return original;
          throw new RepositoryError('DATABASE_ERROR', 'Idempotency result is unavailable');
        }
      }
      // A normalized-email unique collision means another request won the
      // person race. Re-read it and retry the complete group batch.
      if (email && unique && !existing) {
        existing = await this.db.prepare('SELECT * FROM people WHERE lower(email)=? AND deleted_at IS NULL').bind(email).first<Row>();
        if (existing && (text(existing.id) === personId || text(existing.user_id) === userId)) throw new RepositoryError('SELF_FRIEND', 'You cannot add your own linked person as a friend');
        if (existing) { await create(existing); return this.group(id, userId); }
      }
      throw error;
    }
    return this.group(id, userId);
  }
  async updateGroup(id: string, userId: string, input: { name: string; currency: string }) {
    const result = await this.db.prepare("UPDATE groups SET name=?,currency=?,updated_at=? WHERE id=? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id=? AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL)").bind(input.name, input.currency, now(), id, id, userId).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can update this group');
    return this.group(id, userId);
  }
  async deleteGroup(id: string, userId?: string) {
    const guard = userId ? " AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id=? AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL)" : '';
    const args = userId ? [now(), now(), id, id, userId] : [now(), now(), id];
    const result = await this.db.prepare(`UPDATE groups SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL${guard}`).bind(...args).run();
    if (userId && Number(result.meta?.changes ?? 0) === 0) throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can delete this group');
  }
  async addPerson(groupId: string, person: { name: string; email?: string | null }, userId?: string, creatorPersonId?: string) {
    const id = uid(), t = now(), email = person.email?.trim().toLowerCase() ?? null;
    const ownerGuard = userId ? { sql: 'EXISTS (SELECT 1 FROM group_members owner_member WHERE owner_member.group_id=? AND owner_member.user_id=? AND owner_member.role=\'owner\' AND owner_member.deleted_at IS NULL)', args: [groupId, userId] } : { sql: '1=1', args: [] as unknown[] };
    if (email) {
      const linkedUser = userId ? await this.db.prepare('SELECT email FROM users WHERE id=?').bind(userId).first<Row>() : null;
      const creator = creatorPersonId ? await this.db.prepare('SELECT * FROM people WHERE id=? AND deleted_at IS NULL').bind(creatorPersonId).first<Row>() : null;
      if (text(linkedUser?.email).toLowerCase() === email || (creator && text(creator.email).toLowerCase() === email)) throw new RepositoryError('SELF_FRIEND', 'You cannot add your own linked person as a friend');
      const existing = await this.db.prepare('SELECT * FROM people WHERE lower(email)=? AND deleted_at IS NULL').bind(email).first<Row>();
      if (existing) {
        if (text(existing.id) === creatorPersonId || text(existing.user_id) === userId) throw new RepositoryError('SELF_FRIEND', 'You cannot add your own linked person as a friend');
        // An email match identifies the canonical ledger person, not consent
        // to join this group. Only an already accepted active membership may
        // retain its user binding; every new or reactivated membership stays
        // ledger-only until invitation acceptance.
        const result = await this.db.batch([
          this.db.prepare(`UPDATE group_members SET user_id=CASE WHEN deleted_at IS NULL AND user_id IS NOT NULL THEN user_id ELSE NULL END,deleted_at=NULL,role=CASE WHEN deleted_at IS NULL THEN role ELSE 'member' END WHERE group_id=? AND person_id=? AND ${ownerGuard.sql}`).bind(groupId, existing.id, ...ownerGuard.args),
          this.db.prepare(`INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) SELECT ?,?,NULL,?,'member' WHERE ${ownerGuard.sql} AND NOT EXISTS (SELECT 1 FROM group_members WHERE group_id=? AND person_id=?)`).bind(groupId, existing.id, t, ...ownerGuard.args, groupId, existing.id),
        ]);
        const changes = result.length ? result.reduce((total, statement) => total + Number((statement as { meta?: { changes?: number } }).meta?.changes ?? 0), 0) : 1;
        if (userId && changes === 0) {
          const stillOwner = await this.db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND role=\'owner\' AND deleted_at IS NULL').bind(groupId, userId).first<Row>();
          if (!stillOwner) throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can add people');
        }
        return { id: text(existing.id), name: text(existing.name), email, createdAt: text(existing.created_at) };
      }
    }
    const result = await this.db.batch([
      this.db.prepare(`INSERT INTO people(id,name,email,created_at) SELECT ?,?,?,? WHERE ${ownerGuard.sql}`).bind(id, person.name, email, t, ...ownerGuard.args),
      this.db.prepare(`INSERT INTO group_members(group_id,person_id,joined_at,role) SELECT ?,?,?, 'member' WHERE ${ownerGuard.sql}`).bind(groupId, id, t, ...ownerGuard.args),
    ]);
    if (userId && Number((result[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can add people');
    return { id, name: person.name, email, createdAt: t };
  }

  private async rawExpense(id: string) { return this.db.prepare('SELECT * FROM expenses WHERE id=?').bind(id).first<Row>(); }
  private async hydrateExpenses(rows: Row[]): Promise<Expense[]> {
    if (!rows.length) return [];
    // D1 limits the number of bound parameters. Keep the two child queries
    // below safely under that limit while still hydrating a page in bulk.
    const payerRows = new Map<string, Row[]>();
    const splitRows = new Map<string, Row[]>();
    const ids = rows.map((row) => text(row.id));
    for (let start = 0; start < ids.length; start += 90) {
      const chunk = ids.slice(start, start + 90);
      const placeholders = chunk.map(() => '?').join(',');
      const [ps, ss] = await Promise.all([
        this.db.prepare(`SELECT expense_id,person_id,amount_minor FROM payers WHERE expense_id IN (${placeholders}) ORDER BY expense_id,rowid`).bind(...chunk).all<Row>(),
        this.db.prepare(`SELECT expense_id,person_id,amount_minor,metadata_json FROM splits WHERE expense_id IN (${placeholders}) ORDER BY expense_id,rowid`).bind(...chunk).all<Row>(),
      ]);
      for (const payer of ps.results) { const expenseId = text(payer.expense_id); payerRows.set(expenseId, [...(payerRows.get(expenseId) ?? []), payer]); }
      for (const split of ss.results) { const expenseId = text(split.expense_id); splitRows.set(expenseId, [...(splitRows.get(expenseId) ?? []), split]); }
    }
    return rows.map((row) => {
      const payers = payerRows.get(text(row.id)) ?? [];
      const splits = splitRows.get(text(row.id)) ?? [];
      return {
      id: text(row.id), groupId: text(row.group_id), description: text(row.description), amountMinor: minor(row.amount_minor), currency: currency(row.currency),
      date: text(row.expense_date), category: row.category == null ? null : text(row.category), notes: row.notes == null ? null : text(row.notes),
      createdBy: text(row.created_by), createdAt: text(row.created_at), updatedAt: text(row.updated_at), deletedAt: row.deleted_at == null ? null : text(row.deleted_at), version: number(row.version) || 1,
      clientOperationId: row.client_operation_id == null ? null : (() => { const value = text(row.client_operation_id); const prefix = `${text(row.group_id)}:`; return value.startsWith(prefix) ? value.slice(prefix.length) : value; })(),
      payers: payers.map((p) => ({ personId: text(p.person_id), amountMinor: minor(p.amount_minor) })),
      splits: splits.map((s) => ({ personId: text(s.person_id), amountMinor: minor(s.amount_minor), metadata: s.metadata_json ? JSON.parse(text(s.metadata_json)) as Record<string, unknown> : undefined })),
      };
    });
  }
  private async hydrateExpense(row: Row): Promise<Expense> {
    return (await this.hydrateExpenses([row]))[0];
  }

  private mapScheduled(row: Row, payers: Row[] = [], splits: Row[] = []): ScheduledExpense {
    let weekdays: ScheduledExpense['weekdays'] = [];
    try { const parsed = JSON.parse(text(row.weekdays_json)); if (Array.isArray(parsed)) weekdays = parsed as ScheduledExpense['weekdays']; } catch { /* retain the safe empty default */ }
    return {
      id: text(row.id), groupId: text(row.group_id), description: text(row.description), amountMinor: minor(row.amount_minor), currency: currency(row.currency), category: row.category == null ? null : text(row.category),
      startDate: text(row.start_date), endDate: row.end_date == null ? null : text(row.end_date), frequency: text(row.frequency) as ScheduledExpense['frequency'], interval: number(row.interval_count),
      weekdays, timezone: text(row.timezone), status: text(row.status) as ScheduledExpenseStatus, blockedReason: row.blocked_reason == null ? null : text(row.blocked_reason),
      nextOccurrenceDate: row.next_occurrence_date == null ? null : text(row.next_occurrence_date), createdBy: text(row.created_by), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
      version: number(row.version) || 1, clientOperationId: row.client_operation_id == null ? null : (() => { const value = text(row.client_operation_id); const prefix = `${text(row.group_id)}:`; return value.startsWith(prefix) ? value.slice(prefix.length) : value; })(),
      payers: payers.map((payer) => ({ personId: text(payer.person_id), amountMinor: minor(payer.amount_minor) })),
      splits: splits.map((split) => ({ personId: text(split.person_id), amountMinor: minor(split.amount_minor), metadata: (() => { try { return split.metadata_json ? JSON.parse(text(split.metadata_json)) as Record<string, unknown> : undefined; } catch { return undefined; } })() })),
    };
  }
  private async hydrateScheduled(row: Row): Promise<ScheduledExpense> {
    const id = text(row.id);
    const [payers, splits] = await Promise.all([
      this.db.prepare('SELECT person_id,amount_minor FROM scheduled_payers WHERE scheduled_expense_id=? ORDER BY rowid').bind(id).all<Row>(),
      this.db.prepare('SELECT person_id,amount_minor,metadata_json FROM scheduled_splits WHERE scheduled_expense_id=? ORDER BY rowid').bind(id).all<Row>(),
    ]);
    return this.mapScheduled(row, payers.results, splits.results);
  }
  private async hydrateScheduledRows(rows: Row[]): Promise<ScheduledExpense[]> {
    if (!rows.length) return [];
    const payerRows = new Map<string, Row[]>(), splitRows = new Map<string, Row[]>();
    const ids = rows.map((row) => text(row.id));
    // Keep both child queries below D1's parameter limit. This also keeps the
    // Cron path at a predictable number of D1 subrequests.
    for (let start = 0; start < ids.length; start += 90) {
      const chunk = ids.slice(start, start + 90), placeholders = chunk.map(() => '?').join(',');
      const [payers, splits] = await Promise.all([
        this.db.prepare(`SELECT scheduled_expense_id,person_id,amount_minor FROM scheduled_payers WHERE scheduled_expense_id IN (${placeholders}) ORDER BY scheduled_expense_id,rowid`).bind(...chunk).all<Row>(),
        this.db.prepare(`SELECT scheduled_expense_id,person_id,amount_minor,metadata_json FROM scheduled_splits WHERE scheduled_expense_id IN (${placeholders}) ORDER BY scheduled_expense_id,rowid`).bind(...chunk).all<Row>(),
      ]);
      for (const payer of payers.results) { const id = text(payer.scheduled_expense_id); payerRows.set(id, [...(payerRows.get(id) ?? []), payer]); }
      for (const split of splits.results) { const id = text(split.scheduled_expense_id); splitRows.set(id, [...(splitRows.get(id) ?? []), split]); }
    }
    return rows.map((row) => this.mapScheduled(row, payerRows.get(text(row.id)) ?? [], splitRows.get(text(row.id)) ?? []));
  }
  async scheduledExpenses(groupId: string, options: { limit?: number; offset?: number } = {}): Promise<ScheduledExpense[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100), offset = Math.max(options.offset ?? 0, 0);
    const rows = (await this.db.prepare('SELECT * FROM scheduled_expenses WHERE group_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(groupId, limit, offset).all<Row>()).results;
    return this.hydrateScheduledRows(rows);
  }
  async scheduledExpense(id: string): Promise<ScheduledExpense | null> {
    const row = await this.db.prepare('SELECT * FROM scheduled_expenses WHERE id=?').bind(id).first<Row>();
    return row ? this.hydrateScheduled(row) : null;
  }
  private async firstUngeneratedOccurrence(id: string, definition: ReturnType<typeof recurrenceDefinition>, fromDate: string) {
    const generated = new Set((await this.db.prepare('SELECT occurrence_date FROM scheduled_occurrences WHERE scheduled_expense_id=? AND occurrence_date>=?').bind(id, fromDate).all<Row>()).results.map((row) => text(row.occurrence_date)));
    let candidate = firstOccurrenceOnOrAfter(definition, fromDate);
    while (candidate && (!definition.endDate || compareDates(candidate, definition.endDate) <= 0)) {
      if (!generated.has(candidate)) return candidate;
      candidate = nextOccurrenceDate(definition, candidate);
    }
    return null;
  }
  async createScheduledExpense(groupId: string, userId: string, input: ScheduledExpenseInput) {
    const hash = stableJson(input), operation = input.client_operation_id ? await this.operation('scheduled.create', userId, groupId, input.client_operation_id, hash) : { id: uid(), claim: true };
    if (!operation.claim) { const existing = await this.scheduledExpense(operation.id); if (existing?.groupId === groupId) return existing; throw new RepositoryError('DATABASE_ERROR', 'Idempotency result is unavailable'); }
    const id = operation.id, t = now(), actor = this.activeMutationGuard(groupId, userId), participants = this.activeParticipantGuard(groupId, [...input.payers, ...input.splits].map((p) => p.person_id));
    const definition = { startDate: input.start_date, endDate: input.end_date, frequency: input.frequency, interval: input.interval, weekdays: input.weekdays };
    const candidate = firstOccurrenceOnOrAfter(definition);
    const next = candidate && (!input.end_date || compareDates(candidate, input.end_date) <= 0) ? candidate : null;
    const status = next ? 'active' : 'completed';
    const statements = [
      ...(input.client_operation_id ? [this.db.prepare(`INSERT INTO idempotency_keys(kind,user_id,group_id,operation_id,request_hash,entity_id,created_at) SELECT ?,?,?,?,?,?,? WHERE ${actor.sql} AND ${participants.sql}`).bind('scheduled.create', userId, groupId, input.client_operation_id, hash, id, t, ...actor.args, ...participants.args)] : []),
      this.db.prepare(`INSERT INTO scheduled_expenses(id,group_id,description,amount_minor,currency,category,start_date,end_date,frequency,interval_count,weekdays_json,timezone,status,next_occurrence_date,created_by,created_at,updated_at,version,client_operation_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,? WHERE ${actor.sql} AND ${participants.sql}`).bind(id, groupId, input.description, input.amount_minor, input.currency, input.category ?? null, input.start_date, input.end_date ?? null, input.frequency, input.interval, JSON.stringify(input.weekdays), input.timezone, status, next, userId, t, t, input.client_operation_id ? `${groupId}:${input.client_operation_id}` : null, ...actor.args, ...participants.args),
       ...input.payers.map((payer) => this.db.prepare('INSERT INTO scheduled_payers(scheduled_expense_id,person_id,amount_minor) VALUES(?,?,?)').bind(id, payer.person_id, payer.amount_minor)),
       ...input.splits.map((split) => this.db.prepare('INSERT INTO scheduled_splits(scheduled_expense_id,person_id,amount_minor,metadata_json) VALUES(?,?,?,?)').bind(id, split.person_id, split.amount_minor, split.metadata ? JSON.stringify(split.metadata) : null)),
    ];
    try { await this.db.batch(statements); } catch (error) {
      if (!input.client_operation_id || !Repository.isUnique(error)) throw error;
      const existing = await this.existingClaim('scheduled.create', userId, groupId, input.client_operation_id);
      if (!existing) throw error;
      if (text(existing.request_hash) !== hash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
      const found = await this.scheduledExpense(text(existing.entity_id)); if (found?.groupId === groupId) return found; throw error;
    }
    const created = await this.scheduledExpense(id); if (!created) throw new RepositoryError('MEMBER_REQUIRED', 'The submitting user or a scheduled participant is no longer active'); return created;
  }
  async updateScheduledExpense(id: string, userId: string, input: ScheduledExpenseInput) {
    if (!input.version) throw new RepositoryError('CONFLICT', 'A record version is required');
    const old = await this.scheduledExpense(id); if (!old || old.version !== input.version) throw new RepositoryError('CONFLICT', 'The scheduled expense was changed or deleted by another request');
    // A template edit never backfills dates that were in the past under the
    // previous definition. Already generated rows remain ordinary expenses;
    // only the next local calendar occurrence uses the new definition.
    const definition = { startDate: input.start_date, endDate: input.end_date, frequency: input.frequency, interval: input.interval, weekdays: input.weekdays };
    const next = await this.firstUngeneratedOccurrence(id, definition, localDateForTimeZone(new Date(), input.timezone));
    const status = old.status === 'active' && !next ? 'completed' : old.status === 'completed' && next ? 'active' : old.status;
    const claimId = uid();
    const timestamp = now(), version = input.version + 1;
    const actor = this.activeMutationGuard(old.groupId, userId), participants = this.activeParticipantGuard(old.groupId, [...input.payers, ...input.splits].map((p) => p.person_id));
    const batchResult = await this.conditionalBatch([
      this.db.prepare(`UPDATE scheduled_expenses SET description=?,amount_minor=?,currency=?,start_date=?,end_date=?,frequency=?,interval_count=?,weekdays_json=?,timezone=?,status=?,blocked_reason=NULL,next_occurrence_date=?,generation_claim_id=?,updated_at=?,version=? WHERE id=? AND version=? AND generation_claim_id IS NULL AND ${actor.sql} AND ${participants.sql}`).bind(input.description, input.amount_minor, input.currency, input.start_date, input.end_date ?? null, input.frequency, input.interval, JSON.stringify(input.weekdays), input.timezone, status, next, claimId, timestamp, version, id, input.version, ...actor.args, ...participants.args),
      this.db.prepare('DELETE FROM scheduled_payers WHERE scheduled_expense_id=? AND EXISTS (SELECT 1 FROM scheduled_expenses WHERE id=? AND version=? AND generation_claim_id=?)').bind(id, id, version, claimId),
      this.db.prepare('DELETE FROM scheduled_splits WHERE scheduled_expense_id=? AND EXISTS (SELECT 1 FROM scheduled_expenses WHERE id=? AND version=? AND generation_claim_id=?)').bind(id, id, version, claimId),
       ...input.payers.map((payer) => this.db.prepare('INSERT INTO scheduled_payers(scheduled_expense_id,person_id,amount_minor) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM scheduled_expenses WHERE id=? AND version=? AND generation_claim_id=?)').bind(id, payer.person_id, payer.amount_minor, id, version, claimId)),
       ...input.splits.map((split) => this.db.prepare('INSERT INTO scheduled_splits(scheduled_expense_id,person_id,amount_minor,metadata_json) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM scheduled_expenses WHERE id=? AND version=? AND generation_claim_id=?)').bind(id, split.person_id, split.amount_minor, split.metadata ? JSON.stringify(split.metadata) : null, id, version, claimId)),
      this.db.prepare('UPDATE scheduled_expenses SET category=? WHERE id=? AND version=? AND generation_claim_id=?').bind(input.category ?? null, id, version, claimId),
      this.db.prepare('UPDATE scheduled_expenses SET generation_claim_id=NULL WHERE id=? AND version=? AND generation_claim_id=?').bind(id, version, claimId),
    ]);
    const parentChanges = Number((batchResult[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes);
    if (batchResult.length && parentChanges === 0) throw new RepositoryError('CONFLICT', 'The scheduled expense was changed or deleted by another request');
    const current = await this.scheduledExpense(id); if (!current || current.version !== version) throw new RepositoryError('CONFLICT', 'The scheduled expense was changed by another request');
    return current;
  }
  private async changeScheduledStatus(id: string, userId: string | undefined, version: number, status: ScheduledExpenseStatus, asOf = new Date()) {
    const before = await this.scheduledExpense(id);
    if (!before) throw new RepositoryError('CONFLICT', 'The scheduled expense was changed or deleted by another request');
    if (before.status === 'cancelled' && status !== 'cancelled') throw new RepositoryError('CONFLICT', 'A cancelled scheduled expense cannot be resumed');
    if (status === 'paused' && before.status !== 'active') throw new RepositoryError('CONFLICT', 'Only an active scheduled expense can be paused');
    if (status === 'active' && before.status !== 'paused' && before.status !== 'blocked') throw new RepositoryError('CONFLICT', 'Only a paused or blocked scheduled expense can be resumed');
    if (status === 'cancelled' && before.status === 'cancelled') {
      if (before.version !== version) throw new RepositoryError('CONFLICT', 'The scheduled expense was changed by another request');
      return before;
    }
    const nextOccurrence = status === 'active'
      ? await this.firstUngeneratedOccurrence(id, recurrenceDefinition(before), localDateForTimeZone(asOf, before.timezone))
      : before.nextOccurrenceDate;
    const storedStatus = status === 'active' && !nextOccurrence ? 'completed' : status;
    const actor = userId ? this.activeMutationGuard(before.groupId, userId) : { sql: '1=1', args: [] as unknown[] };
    const result = await this.db.prepare(`UPDATE scheduled_expenses SET status=?,blocked_reason=NULL,next_occurrence_date=?,generation_claim_id=NULL,updated_at=?,version=? WHERE id=? AND version=? AND generation_claim_id IS NULL AND ${actor.sql}`).bind(storedStatus, nextOccurrence, now(), version + 1, id, version, ...actor.args).run();
    if (result.meta?.changes !== undefined && result.meta.changes === 0) throw new RepositoryError('CONFLICT', 'The scheduled expense was changed or deleted by another request');
    const current = await this.scheduledExpense(id); if (!current || current.version !== version + 1) throw new RepositoryError('CONFLICT', 'The scheduled expense was changed or deleted by another request');
    return current;
  }
  async pauseScheduledExpense(id: string, userIdOrVersion: string | number, versionMaybe?: number) { const userId = typeof userIdOrVersion === 'string' ? userIdOrVersion : undefined; return this.changeScheduledStatus(id, userId, typeof userIdOrVersion === 'number' ? userIdOrVersion : versionMaybe!, 'paused'); }
  async resumeScheduledExpense(id: string, userIdOrVersion: string | number, versionOrAsOf?: number | Date, asOf = new Date()) { const userId = typeof userIdOrVersion === 'string' ? userIdOrVersion : undefined; const version = typeof userIdOrVersion === 'number' ? userIdOrVersion : versionOrAsOf as number; const effectiveAsOf = typeof versionOrAsOf === 'object' ? versionOrAsOf : asOf; return this.changeScheduledStatus(id, userId, version, 'active', effectiveAsOf); }
  async cancelScheduledExpense(id: string, userIdOrVersion: string | number, versionMaybe?: number) { const userId = typeof userIdOrVersion === 'string' ? userIdOrVersion : undefined; return this.changeScheduledStatus(id, userId, typeof userIdOrVersion === 'number' ? userIdOrVersion : versionMaybe!, 'cancelled'); }

  private generationGuard(template: ScheduledExpense, occurrenceDate: string, claimId: string) {
    const sql = `EXISTS (SELECT 1 FROM scheduled_expenses schedule
      WHERE schedule.id=? AND schedule.group_id=? AND schedule.status='active'
        AND schedule.version=? AND schedule.generation_claim_id=? AND schedule.next_occurrence_date=?
        AND EXISTS (SELECT 1 FROM groups g WHERE g.id=schedule.group_id AND g.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM (
          SELECT person_id FROM scheduled_payers WHERE scheduled_expense_id=schedule.id
          UNION
          SELECT person_id FROM scheduled_splits WHERE scheduled_expense_id=schedule.id
        ) participant WHERE NOT EXISTS (
          SELECT 1 FROM group_members gm JOIN people p ON p.id=gm.person_id
          WHERE gm.group_id=schedule.group_id AND gm.person_id=participant.person_id
            AND gm.deleted_at IS NULL AND p.deleted_at IS NULL
        ))
        AND NOT EXISTS (SELECT 1 FROM scheduled_occurrences existing
          WHERE existing.scheduled_expense_id=schedule.id AND existing.occurrence_date=?))`;
    return { sql, args: [template.id, template.groupId, template.version, claimId, occurrenceDate, occurrenceDate] };
  }
  private async reconcileScheduledOccurrence(template: ScheduledExpense, occurrenceDate: string) {
    const next = nextOccurrenceDate(recurrenceDefinition(template), occurrenceDate);
    const nextCursor = next && (!template.endDate || compareDates(next, template.endDate) <= 0) ? next : null;
    const result = await this.db.prepare(`UPDATE scheduled_expenses SET status=CASE WHEN ? IS NULL THEN 'completed' ELSE status END,next_occurrence_date=?,generation_claim_id=NULL,updated_at=?,version=version+1
      WHERE id=? AND status='active' AND version=? AND generation_claim_id IS NULL AND next_occurrence_date=?
        AND EXISTS (SELECT 1 FROM scheduled_occurrences WHERE scheduled_expense_id=? AND occurrence_date=?)`).bind(nextCursor, nextCursor, now(), template.id, template.version, occurrenceDate, template.id, occurrenceDate).run();
    return result.meta?.changes === undefined || result.meta.changes === 1;
  }
  private async generateScheduledOccurrence(template: ScheduledExpense, occurrenceDate: string): Promise<{ claimed: boolean; generated: boolean; advanced: boolean; blockedReason?: string }> {
    const expense = generatedExpenseInput(template, occurrenceDate), id = uid(), timestamp = now(), claimId = uid();
    const next = nextOccurrenceDate(recurrenceDefinition(template), occurrenceDate);
    const nextCursor = next && (!template.endDate || compareDates(next, template.endDate) <= 0) ? next : null;
    const guard = this.generationGuard(template, occurrenceDate, claimId);
    const guarded = (prefix: string, values: unknown[]) => this.db.prepare(`${prefix} WHERE ${guard.sql}`).bind(...values, ...guard.args);
    const statements = [
      this.db.prepare('UPDATE scheduled_expenses SET generation_claim_id=? WHERE id=? AND status=\'active\' AND version=? AND next_occurrence_date=? AND generation_claim_id IS NULL').bind(claimId, template.id, template.version, occurrenceDate),
      // Generated rows are identified by scheduled_occurrences, not by the
      // user-controlled expense idempotency namespace. A generated
      // client_operation_id would let an ordinary API request collide with
      // this batch's UNIQUE(created_by, client_operation_id) constraint.
       guarded('INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,category,notes,created_by,created_at,updated_at,client_operation_id,version) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,1', [id, template.groupId, expense.description, expense.amount_minor, expense.currency, expense.date, expense.category ?? null, null, template.createdBy, timestamp, timestamp, null]),
      guarded('INSERT INTO payers(expense_id,person_id,amount_minor) SELECT ?,json_extract(value, \'$.person_id\'),json_extract(value, \'$.amount_minor\') FROM json_each(?)', [id, JSON.stringify(expense.payers)]),
       guarded('INSERT INTO splits(expense_id,person_id,amount_minor,metadata_json) SELECT ?,json_extract(value, \'$.person_id\'),json_extract(value, \'$.amount_minor\'),json_extract(value, \'$.metadata\') FROM json_each(?)', [id, JSON.stringify(expense.splits)]),
        this.auditInsert({ groupId: template.groupId, entityType: 'expense', entityId: id, version: 1, action: 'create', actorId: template.createdBy, occurredAt: timestamp, after: this.expenseAfter(null, id, template.groupId, template.createdBy, expense, timestamp, 1) }),
       ...this.projectionStatements(template.groupId, timestamp),
       guarded('INSERT INTO scheduled_occurrences(scheduled_expense_id,occurrence_date,expense_id,created_at) SELECT ?,?,?,?', [template.id, occurrenceDate, id, timestamp]),
      this.db.prepare('UPDATE scheduled_expenses SET status=CASE WHEN ? IS NULL THEN \'completed\' ELSE status END,next_occurrence_date=?,generation_claim_id=NULL,updated_at=?,version=version+1 WHERE id=? AND status=\'active\' AND version=? AND generation_claim_id=? AND next_occurrence_date=? AND EXISTS (SELECT 1 FROM scheduled_occurrences WHERE scheduled_expense_id=? AND occurrence_date=?)').bind(nextCursor, nextCursor, timestamp, template.id, template.version, claimId, occurrenceDate, template.id, occurrenceDate),
      // A guard can legitimately reject after the claim statement (for
      // example, a member was removed just before this atomic batch). Never
      // strand a cursor claim in that case; the next tick can revalidate and
      // block it, or retry it after a benign idempotent race.
      this.db.prepare('UPDATE scheduled_expenses SET generation_claim_id=NULL WHERE id=? AND status=\'active\' AND version=? AND generation_claim_id=? AND next_occurrence_date=? AND NOT EXISTS (SELECT 1 FROM scheduled_occurrences WHERE scheduled_expense_id=? AND occurrence_date=?)').bind(template.id, template.version, claimId, occurrenceDate, template.id, occurrenceDate),
    ];
    try {
      const result = await this.db.batch(statements);
      const changes = (index: number) => Number((result[index] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
      return { claimed: changes(0) === 1, generated: changes(statements.length - 3) === 1, advanced: changes(statements.length - 2) === 1 };
    } catch (error) {
      if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow();
      if (Repository.isUniquenessError(error)) {
        // An occurrence uniqueness race is safe to reconcile. Do not treat a
        // different expense uniqueness error as proof that this occurrence
        // exists: that would silently move a schedule past an ungenerated
        // expense. Such a schedule is explicitly blocked instead.
        if (Repository.isOccurrenceUnique(error)) {
          const occurrence = await this.db.prepare('SELECT 1 FROM scheduled_occurrences WHERE scheduled_expense_id=? AND occurrence_date=?').bind(template.id, occurrenceDate).first<Row>();
          if (occurrence) return { claimed: true, generated: false, advanced: await this.reconcileScheduledOccurrence(template, occurrenceDate) };
        }
        return { claimed: true, generated: false, advanced: false, blockedReason: 'Generation conflicted with an existing expense uniqueness constraint' };
      }
      throw error;
    }
  }
  async generateDueScheduledExpenses(asOf: Date | string = new Date(), options: { maxTemplates?: number; maxOccurrences?: number; maxOccurrencesPerTemplate?: number } = {}) {
    // One atomic generation batch is one D1 subrequest. Twenty templates and
    // twenty occurrences leave room for the candidate, bulk children, member
    // validation, and permanent-failure updates on the free-plan budget.
    // Catch-up is round-robin: one template cannot consume the whole budget
    // while another due template waits behind a multi-year backlog. A cursor
    // is deliberately left due when a cap is reached; later Cron invocations
    // continue the backfill instead of silently dropping historical dates.
    const maxTemplates = Math.max(0, Math.min(options.maxTemplates ?? 20, 20));
    const maxOccurrences = Math.max(0, Math.min(options.maxOccurrences ?? 20, 20));
    const maxOccurrencesPerTemplate = Math.max(0, Math.min(options.maxOccurrencesPerTemplate ?? 20, 20));
    const utcDate = typeof asOf === 'string' ? asOf : localDateForTimeZone(asOf, 'UTC');
    const candidateThrough = typeof asOf === 'string' ? asOf : nextCalendarDate(utcDate);
    await this.db.prepare("UPDATE scheduled_expenses SET status='completed',next_occurrence_date=NULL,generation_claim_id=NULL,updated_at=?,version=version+1 WHERE status='active' AND generation_claim_id IS NULL AND end_date IS NOT NULL AND end_date<=? AND (next_occurrence_date IS NULL OR next_occurrence_date>end_date)").bind(now(), candidateThrough).run();
    const cursorRow = await this.db.prepare('SELECT cursor_id FROM scheduled_generation_cursor WHERE id=1').first<Row>();
    const cursorId = cursorRow?.cursor_id == null ? null : text(cursorRow.cursor_id);
    const rows = (await this.db.prepare("SELECT * FROM scheduled_expenses WHERE status='active' AND next_occurrence_date IS NOT NULL AND start_date<=? AND next_occurrence_date<=? ORDER BY CASE WHEN ? IS NULL OR id>? THEN 0 ELSE 1 END,id LIMIT ?").bind(candidateThrough, candidateThrough, cursorId, cursorId, maxTemplates).all<Row>()).results;
    if (rows.length) {
      // A compare-and-set keeps a slower overlapping Cron invocation from
      // moving a newer cursor backwards. Claims still make overlapping work
      // idempotent, while the persisted cursor guarantees eventual rotation.
      const nextCursor = text(rows[rows.length - 1].id);
      await this.db.prepare('UPDATE scheduled_generation_cursor SET cursor_id=?,updated_at=? WHERE id=1 AND cursor_id IS ?').bind(nextCursor, now(), cursorId).run();
    }
    let generated = 0, processed = 0, blocked = 0;
    const templates = await this.hydrateScheduledRows(rows);
    const groupIds = [...new Set(templates.map((template) => template.groupId))];
    const membersByGroup = new Map<string, Set<string>>();
    if (groupIds.length) {
      const placeholders = groupIds.map(() => '?').join(',');
      const members = (await this.db.prepare(`SELECT gm.group_id,gm.person_id FROM group_members gm JOIN people p ON p.id=gm.person_id JOIN groups g ON g.id=gm.group_id WHERE gm.group_id IN (${placeholders}) AND gm.deleted_at IS NULL AND p.deleted_at IS NULL AND g.deleted_at IS NULL`).bind(...groupIds).all<Row>()).results;
      for (const member of members) { const group = text(member.group_id); membersByGroup.set(group, (membersByGroup.get(group) ?? new Set()).add(text(member.person_id))); }
    }
    const blockedTemplates: Array<{ template: ScheduledExpense; reason: string }> = [];
    const states = templates.map((template) => ({
      template,
      cursor: template.nextOccurrenceDate ?? firstOccurrenceOnOrAfter(recurrenceDefinition(template)),
      processed: 0,
      stopped: false,
    }));
    const stopTemplate = (state: typeof states[number]) => { state.stopped = true; };
    const throughFor = (template: ScheduledExpense) => typeof asOf === 'string' ? asOf : localDateForTimeZone(asOf, template.timezone);

    // Process at most one occurrence per template in each pass. This keeps a
    // template with a large backlog from starving every other due template.
    while (processed < maxOccurrences && states.some((state) => !state.stopped && state.processed < maxOccurrencesPerTemplate)) {
      let madeProgress = false;
      for (const state of states) {
        if (processed >= maxOccurrences || state.stopped || state.processed >= maxOccurrencesPerTemplate) continue;
        let { template, cursor } = state;
        try {
          const allowed = membersByGroup.get(template.groupId);
          if (!allowed || [...new Set([...template.payers, ...template.splits].map((participant) => participant.personId))].some((id) => !allowed.has(id))) {
            blockedTemplates.push({ template, reason: 'The group or a scheduled participant is no longer active' }); blocked += 1; stopTemplate(state); continue;
          }
          const through = throughFor(template);
          const occurrence = cursor && firstOccurrenceOnOrAfter(recurrenceDefinition(template), cursor);
          if (!occurrence || compareDates(occurrence, through) > 0 || (template.endDate && compareDates(occurrence, template.endDate) > 0)) { stopTemplate(state); continue; }
          let result: { claimed: boolean; generated: boolean; advanced: boolean; blockedReason?: string };
          try { result = await this.generateScheduledOccurrence(template, occurrence); }
          catch (error) {
            if (error instanceof RepositoryError && error.code === 'BALANCE_OVERFLOW') { blockedTemplates.push({ template, reason: 'Generation would exceed the group ledger safe integer limit' }); blocked += 1; stopTemplate(state); continue; }
            if (Repository.isPermanentGenerationError(error)) { blockedTemplates.push({ template, reason: 'The scheduled expense contains invalid data and could not be generated' }); blocked += 1; stopTemplate(state); continue; }
            throw error;
          }
          if (result.blockedReason) { blockedTemplates.push({ template, reason: result.blockedReason }); blocked += 1; stopTemplate(state); continue; }
          if (!result.claimed || (!result.generated && !result.advanced)) { stopTemplate(state); continue; }
          if (result.generated) generated += 1;
          processed += 1;
          state.processed += 1;
          const next = nextOccurrenceDate(recurrenceDefinition(template), occurrence);
          const nextCursor = next && (!template.endDate || compareDates(next, template.endDate) <= 0) ? next : null;
          cursor = nextCursor;
          state.cursor = nextCursor;
          state.template = template = { ...template, nextOccurrenceDate: nextCursor, version: template.version + (result.advanced ? 1 : 0) };
          madeProgress = true;
        } catch (error) {
          if (Repository.isPermanentGenerationError(error)) { blockedTemplates.push({ template, reason: 'The scheduled expense contains invalid data and could not be generated' }); blocked += 1; stopTemplate(state); continue; }
          throw error;
        }
      }
      if (!madeProgress) break;
    }
    if (blockedTemplates.length) await this.db.batch(blockedTemplates.map(({ template, reason }) => this.db.prepare("UPDATE scheduled_expenses SET status='blocked',blocked_reason=?,generation_claim_id=NULL,updated_at=?,version=version+1 WHERE id=? AND status='active' AND version=?").bind(reason, now(), template.id, template.version)));
    return { templatesScanned: rows.length, generated, blocked, processed, capped: processed >= maxOccurrences || states.some((state) => !state.stopped && state.processed >= maxOccurrencesPerTemplate) };
  }
  async expensePage(groupId: string, opts: { q?: string; person?: string; category?: string; from?: string; to?: string; currency?: string; limit: number; offset?: number; cursor?: string }) {
    assertLikeSearch(opts.q);
    const cursor = decodeLedgerCursor(opts.cursor);
    const limit = Math.min(Math.max(opts.limit, 1), 100);
    let sql = 'SELECT * FROM expenses WHERE group_id=? AND deleted_at IS NULL'; const args: unknown[] = [groupId];
    if (opts.q) { sql += ' AND (description LIKE ? OR notes LIKE ?)'; args.push(`%${opts.q}%`, `%${opts.q}%`); }
    if (opts.category) { sql += ' AND category=?'; args.push(opts.category); }
    if (opts.currency) { sql += ' AND currency=?'; args.push(opts.currency); }
    if (opts.from) { sql += ' AND expense_date>=?'; args.push(opts.from); }
    if (opts.to) { sql += ' AND expense_date<=?'; args.push(opts.to); }
    if (opts.person) { sql += ' AND id IN (SELECT expense_id FROM splits WHERE person_id=? UNION SELECT expense_id FROM payers WHERE person_id=?)'; args.push(opts.person, opts.person); }
    if (cursor) {
      sql += ' AND (expense_date<? OR (expense_date=? AND created_at<?) OR (expense_date=? AND created_at=? AND id<?))';
      args.push(cursor.date, cursor.date, cursor.createdAt, cursor.date, cursor.createdAt, cursor.id);
    }
    sql += ' ORDER BY expense_date DESC,created_at DESC,id DESC LIMIT ?'; args.push(limit + 1);
    if (!cursor && opts.offset !== undefined) { sql += ' OFFSET ?'; args.push(Math.max(opts.offset, 0)); }
    const rows = (await this.db.prepare(sql).bind(...args).all<Row>()).results;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = await this.hydrateExpenses(pageRows);
    const last = pageRows[pageRows.length - 1];
    return { items, nextCursor: hasMore && last ? encodeLedgerCursor({ date: text(last.expense_date), createdAt: text(last.created_at), id: text(last.id) }) : undefined };
  }
  async expenses(groupId: string, opts: { q?: string; person?: string; category?: string; from?: string; to?: string; currency?: string; limit: number; offset?: number; cursor?: string }) {
    return (await this.expensePage(groupId, opts)).items;
  }
  async allExpenses(groupId: string) {
    const result: Expense[] = []; const pageSize = 100; let cursor: string | undefined;
    while (true) { const page = await this.expensePage(groupId, { limit: pageSize, cursor }); result.push(...page.items); if (!page.nextCursor) return result; cursor = page.nextCursor; }
  }
  async expense(id: string, includeDeleted = false) { const row = await this.rawExpense(id); return row && (includeDeleted || !row.deleted_at) ? this.hydrateExpense(row) : null; }
  private withinRestoreWindow(deletedAt: unknown) { return deletedAt != null && Date.now() - Date.parse(text(deletedAt)) <= 30 * 24 * 60 * 60 * 1000; }

  private async claim(kind: string, userId: string, groupId: string, operationId: string, requestHash: string, entityId: string) {
    await this.db.prepare('INSERT INTO idempotency_keys(kind,user_id,group_id,operation_id,request_hash,entity_id,created_at) VALUES(?,?,?,?,?,?,?)').bind(kind, userId, groupId, operationId, requestHash, entityId, now()).run();
  }
  private async existingClaim(kind: string, userId: string, groupId: string, operationId: string) {
    return this.db.prepare('SELECT * FROM idempotency_keys WHERE kind=? AND user_id=? AND group_id=? AND operation_id=?').bind(kind, userId, groupId, operationId).first<Row>();
  }
  private async operation(kind: string, userId: string, groupId: string, operationId: string, hash: string) {
    const existing = await this.existingClaim(kind, userId, groupId, operationId);
    if (!existing) return { id: uid(), claim: true };
    if (text(existing.request_hash) !== hash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
    return { id: text(existing.entity_id), claim: false };
  }
  private static isUnique(error: unknown) { return error instanceof Error && /unique|constraint/i.test(error.message); }
  private static isUniquenessError(error: unknown) { return error instanceof Error && /unique/i.test(error.message); }
  private static isOccurrenceUnique(error: unknown) { return Repository.isUniquenessError(error) && error instanceof Error && /scheduled_occurrences\.(?:scheduled_expense_id|occurrence_date)/i.test(error.message); }
  private static isRevisionUnique(error: unknown) {
    return Repository.isUnique(error) && error instanceof Error && /revisions\.(entity_type|entity_id|revision)/i.test(error.message);
  }
  private static isBalanceOverflow(error: unknown) { return error instanceof Error && /BALANCE_OVERFLOW|ledger total|integer overflow/i.test(error.message); }
  private static isPermanentGenerationError(error: unknown) {
    return error instanceof RangeError || (error instanceof Error && /too many sql variables|bind parameter|malformed json|syntax error|no such (?:function|table|column)|not null constraint|check constraint|foreign key constraint|datatype mismatch|validation failed|invalid (?:scheduled|recurrence|participant|calendar|input|data)|unable to resolve local calendar date/i.test(error.message));
  }
  private static balanceOverflow() { return new RepositoryError('BALANCE_OVERFLOW', 'The group ledger total exceeds the safe integer range'); }
  private async conditionalBatch(statements: ReturnType<D1Database['prepare']>[]) {
    try {
      return await this.db.batch(statements);
    } catch (error) {
      if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow();
      // A concurrent mutation can collide on the revision number. Only that
      // known unique constraint is a stale-write signal; child/table errors
      // must retain their original meaning and still roll the batch back.
      if (Repository.isRevisionUnique(error)) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
      throw error;
    }
  }

  private activeMutationGuard(groupId: string, userId: string) {
    return { sql: 'EXISTS (SELECT 1 FROM group_members auth_member JOIN groups auth_group ON auth_group.id=auth_member.group_id JOIN people auth_person ON auth_person.id=auth_member.person_id WHERE auth_member.group_id=? AND auth_member.user_id=? AND auth_member.deleted_at IS NULL AND auth_person.deleted_at IS NULL AND auth_group.deleted_at IS NULL)', args: [groupId, userId] };
  }
  private activeParticipantGuard(groupId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return { sql: '1=0', args: [] as unknown[] };
    // Keep participant IDs in one JSON bind.  The schema permits 100 payers
    // and 100 splits, so expanding both arrays into ? parameters can exceed
    // D1's bound-parameter limit even after de-duplication.
    return {
      sql: `NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS (
        SELECT 1 FROM group_members participant JOIN people person ON person.id=participant.person_id
        WHERE participant.group_id=? AND participant.person_id=requested.value
          AND participant.deleted_at IS NULL AND person.deleted_at IS NULL
      ))`,
      args: [JSON.stringify(unique), groupId],
    };
  }
  private auditInsert(event: { groupId: string; entityType: 'expense' | 'settlement'; entityId: string; version: number; action: 'create' | 'update' | 'delete' | 'restore'; actorId: string; occurredAt: string; before?: unknown; after?: unknown }) {
    const table = event.entityType === 'expense' ? 'expenses' : 'settlements';
    // Resolve the actor's person and name in the same D1 batch as the
    // mutation. The name is a snapshot; emails are intentionally never
    // selected or written to the audit table.
    return this.db.prepare(`INSERT INTO audit_events(id,group_id,entity_type,entity_id,version,action,actor_id,actor_person_id,actor_name,occurred_at,before_json,after_json)
      SELECT ?,?,?,?,?,?,?,actor_person.id,COALESCE(actor_person.name,'Unknown user'),?,?,?
      FROM users actor_user LEFT JOIN people actor_person ON actor_person.user_id=actor_user.id AND actor_person.deleted_at IS NULL
      WHERE actor_user.id=? AND EXISTS (SELECT 1 FROM ${table} audited_entity WHERE audited_entity.id=? AND audited_entity.version=?)`)
      .bind(uid(), event.groupId, event.entityType, event.entityId, event.version, event.action, event.actorId, event.occurredAt, event.before == null ? null : JSON.stringify(event.before), event.after == null ? null : JSON.stringify(event.after), event.actorId, event.entityId, event.version);
  }
  private expenseAfter(old: Expense | null, id: string, groupId: string, userId: string, input: ExpenseInput, t: string, version: number): Expense {
    return { id, groupId, description: input.description, amountMinor: input.amount_minor, currency: input.currency, date: input.date, category: input.category ?? null, notes: input.notes ?? null, createdBy: old?.createdBy ?? userId, createdAt: old?.createdAt ?? t, updatedAt: t, deletedAt: null, version, clientOperationId: old?.clientOperationId ?? input.client_operation_id ?? null, payers: input.payers.map((p) => ({ personId: p.person_id, amountMinor: p.amount_minor })), splits: input.splits.map((s) => ({ personId: s.person_id, amountMinor: s.amount_minor, metadata: s.metadata })) };
  }
  async createExpense(groupId: string, userId: string, input: ExpenseInput) {
    const scopedOperation = input.client_operation_id ? `${groupId}:${input.client_operation_id}` : undefined;
    const hash = stableJson(input);
    const operation = input.client_operation_id ? await this.operation('expense.create', userId, groupId, input.client_operation_id, hash) : { id: uid(), claim: true };
    if (!operation.claim) { const existing = await this.expense(operation.id); if (existing && existing.groupId === groupId) return existing; throw new RepositoryError('DATABASE_ERROR', 'Idempotency result is unavailable'); }
    const id = operation.id, t = now(), participants = this.activeParticipantGuard(groupId, [...input.payers, ...input.splits].map((p) => p.person_id)), actor = this.activeMutationGuard(groupId, userId), after = this.expenseAfter(null, id, groupId, userId, input, t, 1);
    const statements = [
      ...(input.client_operation_id ? [this.db.prepare(`INSERT INTO idempotency_keys(kind,user_id,group_id,operation_id,request_hash,entity_id,created_at) SELECT ?,?,?,?,?,?,? WHERE ${actor.sql} AND ${participants.sql}`).bind('expense.create', userId, groupId, input.client_operation_id, hash, id, t, ...actor.args, ...participants.args)] : []),
      this.db.prepare(`INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,category,notes,created_by,created_at,updated_at,client_operation_id,version) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,1 WHERE ${actor.sql} AND ${participants.sql}`).bind(id, groupId, input.description, input.amount_minor, input.currency, input.date, input.category ?? null, input.notes ?? null, userId, t, t, scopedOperation ?? null, ...actor.args, ...participants.args),
       this.db.prepare("INSERT INTO payers(expense_id,person_id,amount_minor) SELECT ?,json_extract(value,'$.person_id'),json_extract(value,'$.amount_minor') FROM json_each(?) WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=1)").bind(id, JSON.stringify(input.payers), id),
       this.db.prepare("INSERT INTO splits(expense_id,person_id,amount_minor,metadata_json) SELECT ?,json_extract(value,'$.person_id'),json_extract(value,'$.amount_minor'),json_extract(value,'$.metadata') FROM json_each(?) WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=1)").bind(id, JSON.stringify(input.splits), id),
       this.auditInsert({ groupId, entityType: 'expense', entityId: id, version: 1, action: 'create', actorId: userId, occurredAt: t, after }),
       ...this.projectionStatements(groupId, t),
    ];
    try { await this.db.batch(statements); } catch (error) {
      if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow();
      if (!input.client_operation_id || !Repository.isUnique(error)) throw error;
      const existing = await this.existingClaim('expense.create', userId, groupId, input.client_operation_id);
      if (!existing) throw error;
      if (text(existing.request_hash) !== hash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
      const found = await this.expense(text(existing.entity_id)); if (found && found.groupId === groupId) return found; throw error;
    }
    const created = await this.expense(id); if (!created) throw new RepositoryError('MEMBER_REQUIRED', 'The submitting user or a participant is no longer active'); return created;
  }

  async updateExpense(id: string, userId: string, input: ExpenseInput) {
    if (!input.version) throw new RepositoryError('CONFLICT', 'A record version is required');
    const old = await this.expense(id); if (!old) throw new RepositoryError('CONFLICT', 'The record was deleted by another request');
    if (old.version !== input.version) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
    const t = now(), next = input.version + 1, revisionId = uid(), actor = this.activeMutationGuard(old.groupId, userId), participants = this.activeParticipantGuard(old.groupId, [...input.payers, ...input.splits].map((p) => p.person_id)), after = this.expenseAfter(old, id, old.groupId, userId, input, t, next);
    const statements = [
      this.db.prepare(`UPDATE expenses SET description=?,amount_minor=?,currency=?,expense_date=?,category=?,notes=?,updated_at=?,version=? WHERE id=? AND version=? AND deleted_at IS NULL AND ${actor.sql} AND ${participants.sql}`).bind(input.description, input.amount_minor, input.currency, input.date, input.category ?? null, input.notes ?? null, t, next, id, input.version, ...actor.args, ...participants.args),
      this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=? AND deleted_at IS NULL)').bind(revisionId, 'expense', id, input.version, JSON.stringify(old), userId, t, id, next),
      this.db.prepare('DELETE FROM payers WHERE expense_id=? AND EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=?)').bind(id, id, next),
      this.db.prepare('DELETE FROM splits WHERE expense_id=? AND EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=?)').bind(id, id, next),
       this.db.prepare("INSERT INTO payers(expense_id,person_id,amount_minor) SELECT ?,json_extract(value,'$.person_id'),json_extract(value,'$.amount_minor') FROM json_each(?) WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=?)").bind(id, JSON.stringify(input.payers), id, next),
       this.db.prepare("INSERT INTO splits(expense_id,person_id,amount_minor,metadata_json) SELECT ?,json_extract(value,'$.person_id'),json_extract(value,'$.amount_minor'),json_extract(value,'$.metadata') FROM json_each(?) WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=?)").bind(id, JSON.stringify(input.splits), id, next),
       this.auditInsert({ groupId: old.groupId, entityType: 'expense', entityId: id, version: next, action: 'update', actorId: userId, occurredAt: t, before: old, after }),
       ...this.projectionStatements(old.groupId, t),
    ];
     await this.conditionalBatch(statements);
    const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.rawExpense(id); if (!revision || !current || number(current.version) !== next) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
    return this.hydrateExpense(current);
  }
  async deleteExpense(id: string, userId: string, version: number) {
    const old = await this.expense(id); if (!old) return false; if (old.version !== version) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); const t = now(), next = version + 1, revisionId = uid(), actor = this.activeMutationGuard(old.groupId, userId);
     await this.conditionalBatch([
       this.db.prepare(`UPDATE expenses SET deleted_at=?,updated_at=?,version=? WHERE id=? AND version=? AND deleted_at IS NULL AND ${actor.sql}`).bind(t, t, next, id, version, ...actor.args),
       this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=? AND deleted_at IS NOT NULL)').bind(revisionId, 'expense', id, version, JSON.stringify(old), userId, t, id, next),
       this.auditInsert({ groupId: old.groupId, entityType: 'expense', entityId: id, version: next, action: 'delete', actorId: userId, occurredAt: t, before: old, after: null }),
       ...this.projectionStatements(old.groupId, t),
    ]);
    const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.rawExpense(id); if (!revision || !current || number(current.version) !== next || !current.deleted_at) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
    return true;
  }
  async restoreExpense(id: string, userId: string, version: number) {
    const old = await this.expense(id, true);
    if (!old || !old.deletedAt || !this.withinRestoreWindow(old.deletedAt) || old.version !== version) throw new RepositoryError('CONFLICT', 'The deleted expense is unavailable or was changed by another request');
    const next = version + 1, t = now(), actor = this.activeMutationGuard(old.groupId, userId), after = { ...old, deletedAt: null, updatedAt: t, version: next };
    await this.conditionalBatch([
      this.db.prepare(`UPDATE expenses SET deleted_at=NULL,updated_at=?,version=? WHERE id=? AND version=? AND deleted_at IS NOT NULL AND ${actor.sql}`).bind(t, next, id, version, ...actor.args),
       this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=? AND deleted_at IS NULL)').bind(uid(), 'expense', id, next, JSON.stringify(old), userId, t, id, next),
       this.auditInsert({ groupId: old.groupId, entityType: 'expense', entityId: id, version: next, action: 'restore', actorId: userId, occurredAt: t, before: old, after }),
       ...this.projectionStatements(old.groupId, t),
    ]);
    const current = await this.expense(id); if (!current || current.version !== next) throw new RepositoryError('CONFLICT', 'The expense changed before it could be restored');
    return current;
  }

  private mapSettlement(row: Row): Settlement { return { id: text(row.id), groupId: text(row.group_id), fromPersonId: text(row.from_person_id), toPersonId: text(row.to_person_id), amountMinor: minor(row.amount_minor), currency: currency(row.currency), date: text(row.settlement_date), note: row.note == null ? null : text(row.note), createdAt: text(row.created_at), updatedAt: text(row.updated_at), deletedAt: row.deleted_at == null ? null : text(row.deleted_at), version: number(row.version) || 1 }; }
  async settlementPage(groupId: string, options: { limit?: number; offset?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100), cursor = decodeLedgerCursor(options.cursor);
    let sql = 'SELECT * FROM settlements WHERE group_id=? AND deleted_at IS NULL'; const args: unknown[] = [groupId];
    if (cursor) { sql += ' AND (settlement_date<? OR (settlement_date=? AND created_at<?) OR (settlement_date=? AND created_at=? AND id<?))'; args.push(cursor.date, cursor.date, cursor.createdAt, cursor.date, cursor.createdAt, cursor.id); }
    sql += ' ORDER BY settlement_date DESC,created_at DESC,id DESC LIMIT ?'; args.push(limit + 1);
    if (!cursor && options.offset !== undefined) { sql += ' OFFSET ?'; args.push(Math.max(options.offset, 0)); }
    const rows = (await this.db.prepare(sql).bind(...args).all<Row>()).results, pageRows = rows.length > limit ? rows.slice(0, limit) : rows, last = pageRows[pageRows.length - 1];
    return { items: pageRows.map((row) => this.mapSettlement(row)), nextCursor: rows.length > limit && last ? encodeLedgerCursor({ date: text(last.settlement_date), createdAt: text(last.created_at), id: text(last.id) }) : undefined };
  }
  async settlements(groupId: string) {
    const result: Settlement[] = []; let cursor: string | undefined;
    while (true) { const page = await this.settlementPage(groupId, { limit: 100, cursor }); result.push(...page.items); if (!page.nextCursor) return result; cursor = page.nextCursor; }
  }
  async settlement(id: string, includeDeleted = false) { const row = await this.db.prepare(`SELECT * FROM settlements WHERE id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`).bind(id).first<Row>(); return row ? this.mapSettlement(row) : null; }
  private settlementParticipantGuard(groupId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return { sql: '1=0', args: [] as unknown[] };
    return {
      sql: `NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS (
        SELECT 1 FROM group_members settlement_participant
        WHERE settlement_participant.group_id=? AND settlement_participant.person_id=requested.value
      ))`,
      args: [JSON.stringify(unique), groupId],
    };
  }
  async createSettlement(groupId: string, userId: string, input: SettlementInput) {
    const hash = stableJson(input), operation = input.client_operation_id ? await this.operation('settlement.create', userId, groupId, input.client_operation_id, hash) : { id: uid(), claim: true };
    if (!operation.claim) { const existing = await this.settlement(operation.id); if (existing && existing.groupId === groupId) return existing; throw new RepositoryError('DATABASE_ERROR', 'Idempotency result is unavailable'); }
    const id = operation.id, t = now(), actor = this.activeMutationGuard(groupId, userId), participants = this.settlementParticipantGuard(groupId, [input.from_person_id, input.to_person_id]);
    const after: Settlement = { id, groupId, fromPersonId: input.from_person_id, toPersonId: input.to_person_id, amountMinor: input.amount_minor, currency: input.currency, date: input.date, note: input.note ?? null, createdAt: t, updatedAt: t, deletedAt: null, version: 1 };
    const statements = [
      ...(input.client_operation_id ? [this.db.prepare(`INSERT INTO idempotency_keys(kind,user_id,group_id,operation_id,request_hash,entity_id,created_at) SELECT ?,?,?,?,?,?,? WHERE ${actor.sql} AND ${participants.sql}`).bind('settlement.create', userId, groupId, input.client_operation_id, hash, id, t, ...actor.args, ...participants.args)] : []),
      this.db.prepare(`INSERT INTO settlements(id,group_id,from_person_id,to_person_id,amount_minor,currency,settlement_date,note,created_by,created_at,updated_at,client_operation_id,version) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,1 WHERE ${actor.sql} AND ${participants.sql}`).bind(id, groupId, input.from_person_id, input.to_person_id, input.amount_minor, input.currency, input.date, input.note ?? null, userId, t, t, input.client_operation_id ? `${groupId}:${input.client_operation_id}` : null, ...actor.args, ...participants.args),
       this.auditInsert({ groupId, entityType: 'settlement', entityId: id, version: 1, action: 'create', actorId: userId, occurredAt: t, after }),
       ...this.projectionStatements(groupId, t),
    ];
    try { await this.db.batch(statements); } catch (error) {
      if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow();
      if (!input.client_operation_id || !Repository.isUnique(error)) throw error;
      const existing = await this.existingClaim('settlement.create', userId, groupId, input.client_operation_id);
      if (!existing) throw error; if (text(existing.request_hash) !== hash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
      const found = await this.settlement(text(existing.entity_id)); if (found && found.groupId === groupId) return found; throw error;
    }
    const created = await this.settlement(id); if (!created) throw new RepositoryError('MEMBER_REQUIRED', 'The submitting user or settlement participants are not valid for this group'); return created;
  }
  async updateSettlement(id: string, userId: string, input: SettlementInput) {
    if (!input.version) throw new RepositoryError('CONFLICT', 'A record version is required'); const old = await this.settlement(id); if (!old) throw new RepositoryError('CONFLICT', 'The record was deleted by another request'); if (old.version !== input.version) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); const t = now(), next = input.version + 1, revisionId = uid(), actor = this.activeMutationGuard(old.groupId, userId), participants = this.settlementParticipantGuard(old.groupId, [input.from_person_id, input.to_person_id]);
    const after: Settlement = { ...old, fromPersonId: input.from_person_id, toPersonId: input.to_person_id, amountMinor: input.amount_minor, currency: input.currency, date: input.date, note: input.note ?? null, updatedAt: t, version: next };
     await this.conditionalBatch([
       this.db.prepare(`UPDATE settlements SET from_person_id=?,to_person_id=?,amount_minor=?,currency=?,settlement_date=?,note=?,updated_at=?,version=? WHERE id=? AND version=? AND deleted_at IS NULL AND ${actor.sql} AND ${participants.sql}`).bind(input.from_person_id, input.to_person_id, input.amount_minor, input.currency, input.date, input.note ?? null, t, next, id, input.version, ...actor.args, ...participants.args),
       this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM settlements WHERE id=? AND version=? AND deleted_at IS NULL)').bind(revisionId, 'settlement', id, input.version, JSON.stringify(old), userId, t, id, next),
        this.auditInsert({ groupId: old.groupId, entityType: 'settlement', entityId: id, version: next, action: 'update', actorId: userId, occurredAt: t, before: old, after }),
        ...this.projectionStatements(old.groupId, t),
    ]);
    const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.db.prepare('SELECT * FROM settlements WHERE id=?').bind(id).first<Row>(); if (!revision || !current || number(current.version) !== next) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); return this.mapSettlement(current);
  }
  async deleteSettlement(id: string, userId: string, version: number) {
    const old = await this.settlement(id); if (!old) return false; if (old.version !== version) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); const t = now(), next = version + 1, revisionId = uid(), actor = this.activeMutationGuard(old.groupId, userId);
     await this.conditionalBatch([
       this.db.prepare(`UPDATE settlements SET deleted_at=?,updated_at=?,version=? WHERE id=? AND version=? AND deleted_at IS NULL AND ${actor.sql}`).bind(t, t, next, id, version, ...actor.args),
       this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM settlements WHERE id=? AND version=? AND deleted_at IS NOT NULL)').bind(revisionId, 'settlement', id, version, JSON.stringify(old), userId, t, id, next),
        this.auditInsert({ groupId: old.groupId, entityType: 'settlement', entityId: id, version: next, action: 'delete', actorId: userId, occurredAt: t, before: old, after: null }),
        ...this.projectionStatements(old.groupId, t),
    ]);
    const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.db.prepare('SELECT * FROM settlements WHERE id=?').bind(id).first<Row>(); if (!revision || !current || number(current.version) !== next || !current.deleted_at) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); return true;
  }
  async restoreSettlement(id: string, userId: string, version: number) {
    const old = await this.settlement(id, true);
    if (!old || !old.deletedAt || !this.withinRestoreWindow(old.deletedAt) || old.version !== version) throw new RepositoryError('CONFLICT', 'The deleted settlement is unavailable or was changed by another request');
    const next = version + 1, t = now(), actor = this.activeMutationGuard(old.groupId, userId), after = { ...old, deletedAt: null, updatedAt: t, version: next };
    await this.conditionalBatch([
      this.db.prepare(`UPDATE settlements SET deleted_at=NULL,updated_at=?,version=? WHERE id=? AND version=? AND deleted_at IS NOT NULL AND ${actor.sql}`).bind(t, next, id, version, ...actor.args),
       this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM settlements WHERE id=? AND version=? AND deleted_at IS NULL)').bind(uid(), 'settlement', id, next, JSON.stringify(old), userId, t, id, next),
       this.auditInsert({ groupId: old.groupId, entityType: 'settlement', entityId: id, version: next, action: 'restore', actorId: userId, occurredAt: t, before: old, after }),
       ...this.projectionStatements(old.groupId, t),
    ]);
    const current = await this.settlement(id); if (!current || current.version !== next) throw new RepositoryError('CONFLICT', 'The settlement changed before it could be restored');
    return current;
  }

  async revisions(type: string, id: string) {
    const rows = (await this.db.prepare('SELECT id,entity_type,entity_id,revision,snapshot_json,created_by,created_at FROM revisions WHERE entity_type=? AND entity_id=? ORDER BY revision DESC').bind(type, id).all<Row>()).results;
    return rows.map((row) => ({ id: text(row.id), entityType: text(row.entity_type), entityId: text(row.entity_id), revision: number(row.revision), snapshot: JSON.parse(text(row.snapshot_json)), createdBy: text(row.created_by), createdAt: text(row.created_at) }));
  }
  async auditPage(groupId: string, options: { limit?: number; offset?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100), cursor = decodeLedgerCursor(options.cursor);
    let sql = 'SELECT id,group_id,entity_type,entity_id,version,action,actor_id,actor_person_id,actor_name,occurred_at,before_json,after_json FROM audit_events WHERE group_id=?'; const args: unknown[] = [groupId];
    if (cursor) { sql += ' AND (occurred_at<? OR (occurred_at=? AND id<?))'; args.push(cursor.createdAt, cursor.createdAt, cursor.id); }
    sql += ' ORDER BY occurred_at DESC,id DESC LIMIT ?'; args.push(limit + 1);
    if (!cursor && options.offset !== undefined) { sql += ' OFFSET ?'; args.push(Math.max(options.offset, 0)); }
    const rows = (await this.db.prepare(sql).bind(...args).all<Row>()).results;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows;
    const parse = (value: unknown) => { if (value == null) return undefined; try { return JSON.parse(text(value)); } catch { return undefined; } };
    const items = pageRows.map((row) => ({ id: text(row.id), groupId: text(row.group_id), entityType: text(row.entity_type) as AuditEvent['entityType'], entityId: text(row.entity_id), version: number(row.version), action: text(row.action) as AuditEvent['action'], actorId: text(row.actor_id), ...(row.actor_person_id == null ? {} : { actorPersonId: text(row.actor_person_id) }), actorName: text(row.actor_name) || 'Unknown user', occurredAt: text(row.occurred_at), ...(row.before_json == null ? {} : { before: parse(row.before_json) }), ...(row.after_json == null ? {} : { after: parse(row.after_json) }) }));
    const last = pageRows[pageRows.length - 1];
    return { items, nextCursor: hasMore && last ? encodeLedgerCursor({ date: text(last.occurred_at), createdAt: text(last.occurred_at), id: text(last.id) }) : undefined };
  }
  async auditHistory(groupId: string, options: { limit?: number; offset?: number; cursor?: string } = {}): Promise<AuditEvent[]> {
    return (await this.auditPage(groupId, options)).items;
  }
  async purgeExpiredData(asOf: Date | string = new Date(), options: { maxTransactions?: number; maxGroups?: number } = {}) {
    const current = typeof asOf === 'string' ? new Date(asOf) : asOf, cutoff = new Date(current.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Cron shares the free-plan request budget with generation and projection
    // backfill. Keep the default purge slice deliberately small.
    const maxTransactions = Math.min(Math.max(options.maxTransactions ?? 8, 0), 100), maxGroups = Math.min(Math.max(options.maxGroups ?? 4, 0), 20);
    const transactionRows = (await this.db.prepare('SELECT id,group_id,\'expense\' AS entity_type FROM expenses WHERE deleted_at IS NOT NULL AND deleted_at<? UNION ALL SELECT id,group_id,\'settlement\' AS entity_type FROM settlements WHERE deleted_at IS NOT NULL AND deleted_at<? ORDER BY id LIMIT ?').bind(cutoff, cutoff, maxTransactions).all<Row>()).results;
    let transactionsPurged = 0, auditEventsPurged = 0;
    for (const row of transactionRows) {
      const id = text(row.id), type = text(row.entity_type);
      const result = await this.db.batch(type === 'expense' ? [
        this.db.prepare('DELETE FROM attachments WHERE expense_id=?').bind(id),
        this.db.prepare('DELETE FROM payers WHERE expense_id=?').bind(id),
        this.db.prepare('DELETE FROM splits WHERE expense_id=?').bind(id),
        this.db.prepare('DELETE FROM revisions WHERE entity_type=? AND entity_id=?').bind(type, id),
        this.db.prepare('DELETE FROM audit_events WHERE entity_type=? AND entity_id=?').bind(type, id),
        this.db.prepare('DELETE FROM expenses WHERE id=? AND deleted_at IS NOT NULL AND deleted_at<?').bind(id, cutoff),
      ] : [
        this.db.prepare('DELETE FROM revisions WHERE entity_type=? AND entity_id=?').bind(type, id),
        this.db.prepare('DELETE FROM audit_events WHERE entity_type=? AND entity_id=?').bind(type, id),
        this.db.prepare('DELETE FROM settlements WHERE id=? AND deleted_at IS NOT NULL AND deleted_at<?').bind(id, cutoff),
      ]);
      const deleted = Number((result[result.length - 1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
      const auditIndex = type === 'expense' ? 4 : 1;
      auditEventsPurged += Number((result[auditIndex] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
      if (deleted) transactionsPurged += 1;
    }
    const groups = (await this.db.prepare('SELECT id FROM groups WHERE deleted_at IS NOT NULL AND deleted_at<? ORDER BY deleted_at,id LIMIT ?').bind(cutoff, maxGroups).all<Row>()).results;
    let groupsPurged = 0;
    for (const row of groups) {
      const groupId = text(row.id);
      const result = await this.db.batch([
        this.db.prepare('DELETE FROM attachments WHERE expense_id IN (SELECT id FROM expenses WHERE group_id=?)').bind(groupId),
        this.db.prepare('DELETE FROM payers WHERE expense_id IN (SELECT id FROM expenses WHERE group_id=?)').bind(groupId),
        this.db.prepare('DELETE FROM splits WHERE expense_id IN (SELECT id FROM expenses WHERE group_id=?)').bind(groupId),
        this.db.prepare('DELETE FROM scheduled_occurrences WHERE scheduled_expense_id IN (SELECT id FROM scheduled_expenses WHERE group_id=?)').bind(groupId),
        this.db.prepare('DELETE FROM scheduled_payers WHERE scheduled_expense_id IN (SELECT id FROM scheduled_expenses WHERE group_id=?)').bind(groupId),
        this.db.prepare('DELETE FROM scheduled_splits WHERE scheduled_expense_id IN (SELECT id FROM scheduled_expenses WHERE group_id=?)').bind(groupId),
        this.db.prepare('DELETE FROM scheduled_expenses WHERE group_id=?').bind(groupId),
        this.db.prepare('DELETE FROM revisions WHERE entity_type IN (\'expense\',\'settlement\') AND entity_id IN (SELECT id FROM expenses WHERE group_id=? UNION SELECT id FROM settlements WHERE group_id=?)').bind(groupId, groupId),
         this.db.prepare('DELETE FROM audit_events WHERE group_id=?').bind(groupId),
         this.db.prepare('DELETE FROM group_balance_projection WHERE group_id=?').bind(groupId),
         this.db.prepare('DELETE FROM ledger_totals WHERE group_id=?').bind(groupId),
         this.db.prepare('DELETE FROM projection_state WHERE group_id=?').bind(groupId),
         this.db.prepare('DELETE FROM group_invitations WHERE group_id=?').bind(groupId),
        this.db.prepare('DELETE FROM group_members WHERE group_id=?').bind(groupId),
        this.db.prepare('DELETE FROM expenses WHERE group_id=?').bind(groupId),
        this.db.prepare('DELETE FROM settlements WHERE group_id=?').bind(groupId),
        // A claim is only replayable through an active group.  Once the group
        // is being physically purged there is no valid access path left, so
        // delete every group-scoped claim (including normal UI expense and
        // settlement keys) before deleting the parent row.  Retaining those
        // FK rows would make an otherwise valid purge fail under FK checks.
        this.db.prepare('DELETE FROM idempotency_keys WHERE group_id=?').bind(groupId),
        this.db.prepare('DELETE FROM groups WHERE id=? AND deleted_at IS NOT NULL AND deleted_at<?').bind(groupId, cutoff),
      ]);
      const deleted = Number((result[result.length - 1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
       auditEventsPurged += Number((result[8] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
      if (deleted) groupsPurged += 1;
    }
    return { cutoff, transactionsScanned: transactionRows.length, transactionsPurged, groupsScanned: groups.length, groupsPurged, auditEventsPurged, capped: transactionRows.length >= maxTransactions || groups.length >= maxGroups };
  }
  async activity(groupId: string) {
    const rows = (await this.db.prepare(`
      SELECT 'expense' AS type,e.id,e.id AS entity_id,1 AS entity_active,e.description AS label,e.amount_minor,e.currency,e.expense_date AS transaction_date,NULL AS from_name,NULL AS to_name,e.created_at
      FROM expenses e WHERE e.group_id=? AND e.deleted_at IS NULL
      UNION ALL
      SELECT 'settlement' AS type,s.id,s.id AS entity_id,0 AS entity_active,s.note AS label,s.amount_minor,s.currency,s.settlement_date AS transaction_date,p_from.name AS from_name,p_to.name AS to_name,s.created_at
      FROM settlements s LEFT JOIN people p_from ON p_from.id=s.from_person_id LEFT JOIN people p_to ON p_to.id=s.to_person_id
      WHERE s.group_id=? AND s.deleted_at IS NULL
      UNION ALL
       SELECT CASE WHEN (r.entity_type='expense' AND e.deleted_at IS NOT NULL AND e.version = r.revision + 1) OR (r.entity_type='settlement' AND s.deleted_at IS NOT NULL AND s.version = r.revision + 1)
         THEN r.entity_type || '_deleted' ELSE r.entity_type || '_revision' END AS type,
        r.id,r.entity_id,
        CASE WHEN r.entity_type='expense' AND e.deleted_at IS NULL THEN 1 ELSE 0 END AS entity_active,
        CASE WHEN r.entity_type='expense' THEN json_extract(r.snapshot_json,'$.description') ELSE json_extract(r.snapshot_json,'$.note') END AS label,
        json_extract(r.snapshot_json,'$.amountMinor') AS amount_minor,
        json_extract(r.snapshot_json,'$.currency') AS currency,
        json_extract(r.snapshot_json,'$.date') AS transaction_date,
        p_from.name AS from_name,p_to.name AS to_name,r.created_at
      FROM revisions r
      LEFT JOIN expenses e ON r.entity_type='expense' AND e.id=r.entity_id
      LEFT JOIN settlements s ON r.entity_type='settlement' AND s.id=r.entity_id
      LEFT JOIN people p_from ON p_from.id=json_extract(r.snapshot_json,'$.fromPersonId')
      LEFT JOIN people p_to ON p_to.id=json_extract(r.snapshot_json,'$.toPersonId')
       WHERE (e.group_id=? OR s.group_id=?) AND ((r.entity_type='expense' AND e.deleted_at IS NULL) OR (r.entity_type='settlement' AND s.deleted_at IS NULL))
      ORDER BY created_at DESC LIMIT 100
    `).bind(groupId, groupId, groupId, groupId).all<Row>()).results;
     return rows.filter((row) => !text(row.type).endsWith('_deleted')).map((row) => ({
      type: text(row.type) as Activity['type'], id: text(row.id), entityId: text(row.entity_id), entityActive: row.entity_active === true || number(row.entity_active) === 1,
      amountMinor: row.amount_minor == null ? null : minor(row.amount_minor), currency: row.currency == null ? null : currency(row.currency),
      transactionDate: text(row.transaction_date), label: row.label == null ? null : text(row.label),
      ...(text(row.type).startsWith('settlement') ? { fromName: row.from_name == null ? null : text(row.from_name), toName: row.to_name == null ? null : text(row.to_name) } : {}),
      createdAt: text(row.created_at),
    })) as Activity[];
  }
  async globalActivity(userId: string, groupId?: string): Promise<Activity[]>;
  async globalActivity(userId: string, groupId: string | undefined, options: { limit?: number; cursor?: string }): Promise<{ items: Activity[]; nextCursor?: string }>;
  async globalActivity(userId: string, groupId?: string, options?: { limit?: number; cursor?: string }): Promise<Activity[] | { items: Activity[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 100), cursor = decodeLedgerCursor(options?.cursor);
    const boundary = cursor ? ' AND (activity.created_at<? OR (activity.created_at=? AND activity.id<?))' : '';
    const binds: unknown[] = groupId ? [userId, groupId] : [userId];
    if (cursor) binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
    if (options) binds.push(limit + 1);
    const rows = (await this.db.prepare(`
      SELECT activity.*,g.name AS group_name FROM (
        SELECT 'expense' AS type,e.id,e.id AS entity_id,1 AS entity_active,e.group_id,e.description AS label,e.amount_minor,e.currency,e.expense_date AS transaction_date,NULL AS from_name,NULL AS to_name,e.created_at
        FROM expenses e WHERE e.deleted_at IS NULL
        UNION ALL
        SELECT 'settlement',s.id,s.id,0,s.group_id,s.note,s.amount_minor,s.currency,s.settlement_date,p_from.name,p_to.name,s.created_at
        FROM settlements s LEFT JOIN people p_from ON p_from.id=s.from_person_id LEFT JOIN people p_to ON p_to.id=s.to_person_id WHERE s.deleted_at IS NULL
        UNION ALL
        SELECT CASE WHEN (r.entity_type='expense' AND e.deleted_at IS NOT NULL AND e.version=r.revision+1) OR (r.entity_type='settlement' AND s.deleted_at IS NOT NULL AND s.version=r.revision+1) THEN r.entity_type||'_deleted' ELSE r.entity_type||'_revision' END,
          r.id,r.entity_id,CASE WHEN r.entity_type='expense' AND e.deleted_at IS NULL THEN 1 ELSE 0 END,
          COALESCE(e.group_id,s.group_id),CASE WHEN r.entity_type='expense' THEN json_extract(r.snapshot_json,'$.description') ELSE json_extract(r.snapshot_json,'$.note') END,
          json_extract(r.snapshot_json,'$.amountMinor'),json_extract(r.snapshot_json,'$.currency'),json_extract(r.snapshot_json,'$.date'),p_from.name,p_to.name,r.created_at
        FROM revisions r LEFT JOIN expenses e ON r.entity_type='expense' AND e.id=r.entity_id LEFT JOIN settlements s ON r.entity_type='settlement' AND s.id=r.entity_id
        LEFT JOIN people p_from ON p_from.id=json_extract(r.snapshot_json,'$.fromPersonId') LEFT JOIN people p_to ON p_to.id=json_extract(r.snapshot_json,'$.toPersonId')
        WHERE (r.entity_type='expense' AND e.deleted_at IS NULL) OR (r.entity_type='settlement' AND s.deleted_at IS NULL)
      ) activity JOIN groups g ON g.id=activity.group_id JOIN group_members gm ON gm.group_id=g.id
       WHERE gm.user_id=? AND gm.deleted_at IS NULL AND g.deleted_at IS NULL${groupId ? ' AND activity.group_id=?' : ''}${boundary}
       ORDER BY activity.created_at DESC,activity.id DESC LIMIT ${options ? '?' : '100'}
    `).bind(...binds).all<Row>()).results;
    const mapped = rows.filter((row) => !text(row.type).endsWith('_deleted')).map((row) => ({ type: text(row.type) as Activity['type'], id: text(row.id), entityId: text(row.entity_id), entityActive: row.entity_active === true || number(row.entity_active) === 1,
      groupId: text(row.group_id), groupName: text(row.group_name), amountMinor: row.amount_minor == null ? null : minor(row.amount_minor), currency: row.currency == null ? null : currency(row.currency), transactionDate: text(row.transaction_date), label: row.label == null ? null : text(row.label),
       ...(text(row.type).startsWith('settlement') ? { fromName: row.from_name == null ? null : text(row.from_name), toName: row.to_name == null ? null : text(row.to_name) } : {}), createdAt: text(row.created_at) })) as Activity[];
    if (!options) return mapped;
    const hasMore = rows.length > limit, items = hasMore ? mapped.slice(0, limit) : mapped, last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? encodeLedgerCursor({ date: last.transactionDate, createdAt: last.createdAt, id: last.id }) : undefined };
  }
  async categories(userId: string) {
    const rows = (await this.db.prepare(`SELECT DISTINCT category FROM (
      SELECT e.category FROM expenses e JOIN group_members gm ON gm.group_id=e.group_id JOIN groups g ON g.id=e.group_id
        WHERE gm.user_id=? AND gm.deleted_at IS NULL AND g.deleted_at IS NULL AND e.deleted_at IS NULL
      UNION ALL
      SELECT se.category FROM scheduled_expenses se JOIN group_members gm ON gm.group_id=se.group_id JOIN groups g ON g.id=se.group_id
        WHERE gm.user_id=? AND gm.deleted_at IS NULL AND g.deleted_at IS NULL
    ) WHERE category IS NOT NULL AND trim(category)<>'' ORDER BY lower(category),category`).bind(userId, userId).all<Row>()).results;
    return rows.map((row) => text(row.category));
  }
  async groupExportPage(groupId: string, options: { limit?: number; expenseCursor?: string | null; settlementCursor?: string | null } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const [g, members, expenses, settlements] = await Promise.all([
      this.db.prepare('SELECT * FROM groups WHERE id=? AND deleted_at IS NULL').bind(groupId).first<Row>().then(mapGroup),
      this.members(groupId),
      options.expenseCursor === null ? Promise.resolve({ items: [], nextCursor: undefined }) : this.expensePage(groupId, { limit, cursor: options.expenseCursor }),
      options.settlementCursor === null ? Promise.resolve({ items: [], nextCursor: undefined }) : this.settlementPage(groupId, { limit, cursor: options.settlementCursor }),
    ]);
    return { version: 1, exportedAt: now(), group: g, members, expenses: expenses.items, settlements: settlements.items, nextCursor: expenses.nextCursor || settlements.nextCursor ? { expenses: expenses.nextCursor ?? null, settlements: settlements.nextCursor ?? null } : undefined };
  }
  async exportPage(userId: string, options: { groupCursor?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 1, 1), 2);
    let cursor: ExportCursor | undefined;
    let afterGroupId: string | undefined;
    if (options.groupCursor) {
      try { cursor = decodeExportCursor(options.groupCursor); }
      catch (error) {
        // Accept the old raw group-id cursor for one release so callers can
        // migrate without losing their place. New cursors are composite and
        // carry both ledger stream positions.
        if (error instanceof RepositoryError && /^[A-Za-z0-9-]{1,128}$/.test(options.groupCursor)) afterGroupId = options.groupCursor;
        else throw error;
      }
    }

    const nextGroup = async (after?: string) => {
      let sql = `SELECT g.id FROM groups g JOIN group_members gm ON gm.group_id=g.id
        WHERE gm.user_id=? AND gm.deleted_at IS NULL AND g.deleted_at IS NULL`;
      const args: unknown[] = [userId];
      if (after) { sql += ' AND g.id>?'; args.push(after); }
      sql += ' ORDER BY g.id LIMIT 1';
      return text((await this.db.prepare(sql).bind(...args).first<Row>())?.id) || undefined;
    };

    const authorizedCursorGroup = async (id: string) => {
      const row = await this.db.prepare(`SELECT g.id FROM groups g JOIN group_members gm ON gm.group_id=g.id
        WHERE g.id=? AND gm.user_id=? AND gm.deleted_at IS NULL AND g.deleted_at IS NULL`).bind(id, userId).first<Row>();
      return row ? text(row.id) : undefined;
    };
    let groupId = cursor ? await authorizedCursorGroup(cursor.groupId) : await nextGroup(afterGroupId);
    if (cursor && !groupId) throw new RepositoryError('INVALID_CURSOR', 'The export pagination cursor is invalid');
    let expenseCursor = cursor?.expenseCursor;
    let settlementCursor = cursor?.settlementCursor;
    const groups = [];
    let nextCursor: string | undefined;
    while (groupId && groups.length < limit) {
      const group = await this.groupExportPage(groupId, { limit: 100, expenseCursor, settlementCursor });
      groups.push(group);
      const continuation = group.nextCursor;
      if (continuation) {
        // Do not advance to another group until both streams in this group
        // are exhausted. This is the cursor boundary that prevents truncation.
        nextCursor = encodeExportCursor({ groupId, expenseCursor: continuation.expenses, settlementCursor: continuation.settlements });
        break;
      }
      const followingGroup = await nextGroup(groupId);
      if (!followingGroup) break;
      if (groups.length >= limit) {
        nextCursor = encodeExportCursor({ groupId: followingGroup });
        break;
      }
      groupId = followingGroup;
      expenseCursor = undefined;
      settlementCursor = undefined;
    }
    return { version: 1, exportedAt: now(), groups, nextCursor };
  }
  async allExport(userId: string) { const groups = await this.groups(userId); const out = []; for (const group of groups) { const [members, expenses, settlements] = await Promise.all([this.members(group.id), this.allExpenses(group.id), this.settlements(group.id)]); out.push({ ...group, members, expenses, settlements }); } return { version: 1, exportedAt: now(), groups: out }; }
  async groupExport(groupId: string) { const g = mapGroup(await this.db.prepare('SELECT * FROM groups WHERE id=? AND deleted_at IS NULL').bind(groupId).first<Row>()); const [members, expenses, settlements] = await Promise.all([this.members(groupId), this.allExpenses(groupId), this.settlements(groupId)]); return { version: 1, exportedAt: now(), group: g, members, expenses, settlements }; }
}
