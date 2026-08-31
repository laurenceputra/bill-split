import { groupSplitDefaultInput, type ExpenseInput, type GroupSplitDefaultInput, type ScheduledExpenseInput, type SettlementInput } from '../shared/schemas';
import type { D1Database } from '@cloudflare/workers-types';
import type { Activity, AuditEvent, Expense, Group, GroupBalanceSummary, GroupInvitation, GroupMember, GroupSplitDefault, ScheduledExpense, ScheduledExpenseStatus, Settlement, Transaction } from '../shared/types';
import { checkedMinor } from '../shared/money';
import { firstOccurrenceOnOrAfter, localDateForTimeZone, nextCalendarDate, nextOccurrenceDate, recurrenceDefinition, compareDates } from '../domain/recurrence';
import { generatedExpenseInput } from '../domain/scheduled-expense';
import { invitationExpiry, normalizeEmail } from '../shared/invitations';
import { normalizeCategoryDescription as normalizeCategoryDescriptionValue } from '../shared/category';
import { APPLICATION_SESSION_ACTIVITY_THROTTLE_MS, APPLICATION_SESSION_IDLE_MS } from '../shared/session-policy';
import { balanceProjectionQuery, boundExpenseProjectionDelta, boundSettlementProjectionDelta, groupSelect, projectionMutation, projectionRevisionGuard } from './ledger-projection';
import { ledgerPeriodBuildGarbageCollection, monthlySummaryMaintenance as runMonthlySummaryMaintenance, previousMonth } from './monthly-summary';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const withinDeadline = (deadlineMs?: number, reserveMs = 25) => deadlineMs == null || Date.now() + reserveMs < deadlineMs;
const identityHash = async (value: string, key: string) => {
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
type Row = Record<string, unknown>;

export class RepositoryError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'CONFLICT' | 'DATABASE_ERROR' | 'BALANCE_OVERFLOW' | 'SELF_FRIEND' | 'AUTH_IDENTITY_CONFLICT' | 'OWNER_REQUIRED' | 'FINAL_OWNER' | 'INVITATION_INVALID' | 'INVITATION_EXPIRED' | 'INVITATION_REVOKED' | 'MEMBER_REQUIRED' | 'INVALID_SEARCH' | 'INVALID_CURSOR' | 'INVALID_PAGINATION' | 'INVALID_DATE' | 'INVALID_SPLIT_DEFAULT' | 'ACCOUNT_DELETION_BLOCKED', message: string, readonly details?: Record<string, unknown>) { super(message); }
}
const text = (value: unknown) => String(value ?? '');
const number = (value: unknown) => Number(value ?? 0);
const flag = (value: unknown) => value === true || value === 1 || text(value) === '1';
const minor = (value: unknown) => checkedMinor(value);
const currency = (value: unknown) => text(value) as Expense['currency'];
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, nested) => nested && typeof nested === 'object' && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : nested);
export const normalizeCategoryDescription = normalizeCategoryDescriptionValue;

export type LedgerCursor = { date: string; createdAt: string; id: string };
const cursorText = (value: unknown) => {
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
export type TransactionCursor = { version: 1; date: string; createdAt: string; kind: Transaction['kind']; id: string };
const isCalendarDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    const parsed = new Date(`${value}T00:00:00Z`);
    return parsed.toISOString().slice(0, 10) === value;
  } catch { return false; }
};
export const encodeTransactionCursor = (value: Omit<TransactionCursor, 'version'> | TransactionCursor) => cursorText({ ...value, version: 1 });
export const decodeTransactionCursor = (value: string | undefined): TransactionCursor | undefined => {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error('invalid cursor');
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)))) as Partial<TransactionCursor>;
    const keys = Object.keys(parsed).sort().join(','), expectedKeys = 'createdAt,date,id,kind,version';
    if (keys !== expectedKeys || parsed.version !== 1 || typeof parsed.date !== 'string' || !isCalendarDate(parsed.date) || typeof parsed.createdAt !== 'string' || !parsed.createdAt || parsed.createdAt.length > 128 || !Number.isFinite(Date.parse(parsed.createdAt)) || (parsed.kind !== 'expense' && parsed.kind !== 'settlement') || typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 200) throw new Error('invalid cursor');
    return { version: 1, date: parsed.date, createdAt: parsed.createdAt, kind: parsed.kind, id: parsed.id };
  } catch { throw new RepositoryError('INVALID_CURSOR', 'The transaction pagination cursor is invalid'); }
};
type ScheduledExpenseCursor = { createdAt: string; id: string };
const encodeScheduledExpenseCursor = (value: ScheduledExpenseCursor) => cursorText(value);
const decodeScheduledExpenseCursor = (value: string | undefined): ScheduledExpenseCursor | undefined => {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error('invalid cursor');
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)))) as Partial<ScheduledExpenseCursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string' || !parsed.id) throw new Error('invalid cursor');
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch { throw new RepositoryError('INVALID_CURSOR', 'The pagination cursor is invalid'); }
};
export const assertLikeSearch = (value: string | undefined) => {
  if (value === undefined) return;
  // D1's LIKE pattern limit applies to the complete pattern, including the
  // wildcards added by the repository.
  if (new TextEncoder().encode(`%${value}%`).byteLength > 50) throw new RepositoryError('INVALID_SEARCH', 'Search text must be at most 48 UTF-8 bytes');
};
const escapedLike = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

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

const authorizedGroupSelect = `SELECT g.*,gm.role,
  (SELECT COUNT(*) FROM group_members member_count WHERE member_count.group_id=g.id AND member_count.deleted_at IS NULL) AS member_count,
  (SELECT p.name FROM people p JOIN group_members other_member ON other_member.person_id=p.id
    WHERE other_member.group_id=g.id AND other_member.person_id != gm.person_id AND other_member.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY p.name LIMIT 1) AS counterpart_name
  FROM groups g JOIN group_members gm ON gm.group_id=g.id
  WHERE g.id=? AND g.deleted_at IS NULL AND gm.user_id=? AND gm.deleted_at IS NULL`;

export class Repository {
  constructor(private readonly db: D1Database, private readonly identityTombstoneKey?: string) {}

  private tombstoneKey() {
    const key = this.identityTombstoneKey?.trim();
    if (!key) throw new RepositoryError('DATABASE_ERROR', 'Identity tombstone protection is not configured');
    return key;
  }

  /** The SQL migration and this method intentionally share trim + lowercase. */
  normalizeCategoryDescription(description: string) { return normalizeCategoryDescriptionValue(description); }

  async categoryPreference(userId: string, description: string) {
    const normalized = this.normalizeCategoryDescription(description);
    if (!normalized) return null;
    const row = await this.db.prepare('SELECT category FROM category_preferences WHERE user_id=? AND normalized_description=?').bind(userId, normalized).first<Row>();
    return row?.category == null ? null : text(row.category);
  }
  async categorySuggestion(userId: string, description: string) { return this.categoryPreference(userId, description); }

  /**
   * Build the learning statements separately so callers can append them to
   * the mutation batch. A mutation guard is used by expense/schedule writes:
   * a conditional update that changes zero rows must not still learn a value.
   */
  categoryPreferenceStatements(userId: string, description: string, category: string | null | undefined, updatedAt = now(), guard?: { table: 'expenses' | 'scheduled_expenses'; id: string; version?: number; generationClaimId?: string; revisionId?: string }) {
    const normalized = this.normalizeCategoryDescription(description);
    if (!normalized) return [];
    const guardSql = guard ? ` AND EXISTS (SELECT 1 FROM ${guard.table} learned_entity WHERE learned_entity.id=?${guard.version === undefined ? '' : ' AND learned_entity.version=?'}${guard.table === 'expenses' ? ' AND learned_entity.deleted_at IS NULL' : guard.generationClaimId === undefined ? '' : ' AND learned_entity.generation_claim_id=?'})${guard.revisionId === undefined ? '' : " AND EXISTS (SELECT 1 FROM revisions learned_revision WHERE learned_revision.id=? AND learned_revision.entity_type='expense' AND learned_revision.entity_id=?)"}` : '';
    const guardArgs = guard ? [guard.id, ...(guard.version === undefined ? [] : [guard.version]), ...(guard.table === 'scheduled_expenses' && guard.generationClaimId !== undefined ? [guard.generationClaimId] : []), ...(guard.revisionId === undefined ? [] : [guard.revisionId, guard.id])] : [];
    if (category == null || category.trim() === '') return [this.db.prepare(`DELETE FROM category_preferences WHERE user_id=? AND normalized_description=?${guardSql}`).bind(userId, normalized, ...guardArgs)];
    return [this.db.prepare(`INSERT INTO category_preferences(user_id,normalized_description,category,updated_at) SELECT ?,?,?,? WHERE 1=1${guardSql} ON CONFLICT(user_id,normalized_description) DO UPDATE SET category=excluded.category,updated_at=excluded.updated_at`).bind(userId, normalized, category.trim(), updatedAt, ...guardArgs)];
  }
  preferenceStatements(userId: string, description: string, category: string | null | undefined, updatedAt = now()) { return this.categoryPreferenceStatements(userId, description, category, updatedAt); }

  /** Summary SQL adapters. They intentionally never read group_balance_projection. */
  private projectionRevisionGuard(revisionId: string, entityType: 'expense' | 'settlement', entityId: string) { return projectionRevisionGuard(revisionId, entityType, entityId); }
  private boundExpenseProjectionDelta(expenseId: string, groupId: string, currencyValue: string, payers: Array<{ personId: string; amountMinor: number }>, splits: Array<{ personId: string; amountMinor: number }>, sign: 1 | -1, timestamp: string, revisionId: string | undefined, date: string) { return boundExpenseProjectionDelta(this.db, expenseId, groupId, currencyValue, payers, splits, sign, timestamp, revisionId, date); }
  private boundSettlementProjectionDelta(settlementId: string, groupId: string, currencyValue: string, fromPersonId: string, toPersonId: string, amountMinor: number, sign: 1 | -1, timestamp: string, revisionId: string | undefined, date: string) { return boundSettlementProjectionDelta(this.db, settlementId, groupId, currencyValue, fromPersonId, toPersonId, amountMinor, sign, timestamp, revisionId, date); }
  private projectionMutation(groupId: string, timestamp: string, entity: 'expenses' | 'settlements', id: string, revisionId?: string) { return projectionMutation(this.db, groupId, timestamp, entity, id, revisionId); }

  async monthlySummaryMaintenance(options: { maxGroups?: number; maxMonths?: number; chunkSize?: number; deadlineMs?: number } = {}) {
    return runMonthlySummaryMaintenance(this.db, options);
  }

  async ledgerPeriodBuildGarbageCollection(options: { maxBuilds?: number; chunkSize?: number; deadlineMs?: number } = {}) {
    return ledgerPeriodBuildGarbageCollection(this.db, options);
  }

  async projectionBackfill(options: { maxGroups?: number; maxMonths?: number; chunkSize?: number; deadlineMs?: number } = {}) { return this.monthlySummaryMaintenance(options); }

  async balanceProjection(groupId: string) {
    const query = balanceProjectionQuery();
    const rows = (await this.db.prepare(query.sql).bind(groupId).all<Row>()).results;
    const ready = flag(rows[0]?.read_ready);
    return { ready, rows: rows.filter((row) => row.currency != null).map((row) => ({ currency: currency(row.currency), personId: text(row.person_id), netMinor: minor(row.net_minor) })) };
  }

  private async personForUser(user: Row, email: string, t = now()) {
    if (user.deleted_at != null) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot be linked again');
    const activeUser = this.activeUserGuard(text(user.id));
    let person = await this.db.prepare('SELECT * FROM people WHERE user_id=? AND deleted_at IS NULL').bind(user.id).first<Row>();
    if (!person) {
      const candidate = await this.db.prepare('SELECT * FROM people WHERE lower(email)=? AND deleted_at IS NULL').bind(email).first<Row>();
      if (candidate && (candidate.user_id == null || String(candidate.user_id) === String(user.id))) {
        const linked = await this.db.prepare(`UPDATE people SET user_id=? WHERE id=? AND user_id IS NULL AND ${activeUser.sql}`).bind(user.id, candidate.id, ...activeUser.args).run();
        if (linked.meta?.changes !== undefined && linked.meta.changes === 0) {
          const current = await this.db.prepare('SELECT * FROM people WHERE id=? AND deleted_at IS NULL').bind(candidate.id).first<Row>();
          if (!current || String(current.user_id) !== String(user.id)) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'The authenticated account changed before its person could be linked');
          person = current;
        } else {
          person = { ...candidate, user_id: user.id };
        }
      } else {
        const id = uid();
        // A pre-existing person with this email may belong to another identity.
        // Keep the new identity unambiguous rather than linking accounts.
        try {
          const created = await this.db.prepare(`INSERT INTO people(id,name,email,user_id,created_at) SELECT ?,?,?,?,? WHERE ${activeUser.sql}`).bind(id, email.split('@')[0], candidate ? null : email, user.id, t, ...activeUser.args).run();
          if (created.meta?.changes !== undefined && created.meta.changes === 0) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot be linked again');
          person = { id, name: email.split('@')[0], email: candidate ? null : email, user_id: user.id, created_at: t };
        } catch (error) {
          if (!(error instanceof Error) || !/unique|constraint/i.test(error.message)) throw error;
          const winner = await this.db.prepare('SELECT * FROM people WHERE lower(email)=? AND deleted_at IS NULL').bind(email).first<Row>();
          if (winner && winner.user_id == null) {
            const linked = await this.db.prepare(`UPDATE people SET user_id=? WHERE id=? AND user_id IS NULL AND ${activeUser.sql}`).bind(user.id, winner.id, ...activeUser.args).run();
            if (linked.meta?.changes !== undefined && linked.meta.changes === 0) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot be linked again');
            person = { ...winner, user_id: user.id };
          } else if (winner && String(winner.user_id) === String(user.id)) {
            person = winner;
          } else {
            const created = await this.db.prepare(`INSERT INTO people(id,name,email,user_id,created_at) SELECT ?,?,?,?,? WHERE ${activeUser.sql}`).bind(id, email.split('@')[0], null, user.id, t, ...activeUser.args).run();
            if (created.meta?.changes !== undefined && created.meta.changes === 0) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot be linked again');
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
    const deletedEmailHash = await identityHash(email, this.tombstoneKey());
    const deletedIdentity = await this.db.prepare('SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_email_hash=?').bind(deletedEmailHash).first<Row>();
    if (deletedIdentity) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot be linked again');
    const t = now();
    await this.db.prepare('INSERT OR IGNORE INTO users(id,email,created_at,updated_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM users deleted_user WHERE deleted_user.deleted_at IS NOT NULL AND deleted_user.deleted_email_hash=?)').bind(uid(), email, t, t, deletedEmailHash).run();
    const user = await this.db.prepare('SELECT * FROM users WHERE email=?').bind(email).first<Row>();
    if (!user) throw new RepositoryError('DATABASE_ERROR', 'Unable to create user');
    return this.personForUser(user, email, t);
  }
  async me(email: string) { return this.user(email); }

  async createApplicationSession(userId: string, tokenHash: string, createdAt = now(), idleExpiresAt = new Date(Date.parse(createdAt) + APPLICATION_SESSION_IDLE_MS).toISOString()) {
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) throw new RepositoryError('DATABASE_ERROR', 'Application session credentials must be SHA-256 digests');
    const id = uid();
    const active = await this.db.prepare('SELECT id FROM users WHERE id=? AND deleted_at IS NULL').bind(userId).first<Row>();
    if (!active) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'The authenticated account is not available');
    await this.db.prepare('INSERT INTO application_sessions(id,user_id,token_hash,created_at,last_activity_at,idle_expires_at) VALUES(?,?,?,?,?,?)').bind(id, userId, tokenHash, createdAt, createdAt, idleExpiresAt).run();
    return { id, createdAt, lastActivityAt: createdAt, idleExpiresAt };
  }

  async applicationSession(tokenHash: string, asOf = now()) {
    const row = await this.db.prepare(`SELECT s.id,s.user_id,s.created_at,s.last_activity_at,s.idle_expires_at,u.email,u.clerk_user_id,u.deleted_at,p.id AS person_id
      FROM application_sessions s JOIN users u ON u.id=s.user_id LEFT JOIN people p ON p.user_id=u.id AND p.deleted_at IS NULL
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.idle_expires_at>? AND u.deleted_at IS NULL`).bind(tokenHash, asOf).first<Row>();
    if (!row) return null;
    return { id: text(row.id), userId: text(row.user_id), email: text(row.email), personId: text(row.person_id), clerkUserId: row.clerk_user_id == null ? undefined : text(row.clerk_user_id), createdAt: text(row.created_at), lastActivityAt: text(row.last_activity_at), idleExpiresAt: text(row.idle_expires_at) };
  }

  async renewApplicationSession(sessionId: string, asOf = now(), throttleMs = APPLICATION_SESSION_ACTIVITY_THROTTLE_MS) {
    const threshold = new Date(Date.parse(asOf) - throttleMs).toISOString();
    const idleExpiresAt = new Date(Date.parse(asOf) + APPLICATION_SESSION_IDLE_MS).toISOString();
    // The throttle predicate is part of the update, so two foreground tabs
    // cannot both renew the same session after the 24-hour boundary.
    const updated = await this.db.prepare(`UPDATE application_sessions SET last_activity_at=?,idle_expires_at=?
      WHERE id=? AND revoked_at IS NULL AND idle_expires_at>? AND last_activity_at<=?`).bind(asOf, idleExpiresAt, sessionId, asOf, threshold).run();
    if (Number(updated.meta?.changes ?? 0) > 0) return { lastActivityAt: asOf, idleExpiresAt, renewed: true };
    const current = await this.db.prepare(`SELECT id,last_activity_at,idle_expires_at FROM application_sessions WHERE id=? AND revoked_at IS NULL AND idle_expires_at>?`).bind(sessionId, asOf).first<Row>();
    if (!current) return null;
    return { lastActivityAt: text(current.last_activity_at), idleExpiresAt: text(current.idle_expires_at), renewed: false };
  }

  async revokeApplicationSession(sessionId: string, revokedAt = now()) {
    await this.db.prepare('UPDATE application_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(revokedAt, sessionId).run();
  }

  /** Revoke only the presented device session when Clerk has switched users. */
  async revokeApplicationSessionForIdentitySwitch(sessionId: string, clerkUserId: string, revokedAt = now()) {
    await this.db.prepare(`UPDATE application_sessions SET revoked_at=?
      WHERE id=? AND revoked_at IS NULL AND EXISTS (
        SELECT 1 FROM users WHERE users.id=application_sessions.user_id
          AND users.deleted_at IS NULL AND (users.clerk_user_id IS NULL OR users.clerk_user_id!=?)
      )`).bind(revokedAt, sessionId, clerkUserId).run();
  }

  async revokeAllApplicationSessions(userId: string, revokedAt = now()) {
    await this.db.prepare('UPDATE application_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(revokedAt, userId).run();
  }

  async purgeExpiredApplicationSessions(asOf: Date | string = new Date(), limit = 100) {
    const timestamp = typeof asOf === 'string' ? asOf : asOf.toISOString();
    const bounded = Math.min(Math.max(limit, 1), 500);
    const result = await this.db.prepare(`DELETE FROM application_sessions WHERE id IN (
      SELECT id FROM application_sessions WHERE idle_expires_at<=? OR revoked_at IS NOT NULL ORDER BY id LIMIT ?
    )`).bind(timestamp, bounded).run();
    return { purged: Number(result.meta?.changes ?? 0), capped: Number(result.meta?.changes ?? 0) >= bounded };
  }

  /**
   * Delete the application's account without deleting financial rows. The
   * owner check is performed before and repeated by the conditional claim in
   * the single D1 batch, so a blocked or racing request cannot partially
   * revoke invitations or memberships. Actor IDs and person IDs remain FK
   * anchors; audit and membership-event name snapshots are the intentional
   * retained record of who performed historical financial work.
   */
  async deleteAccount(userId: string) {
    const tombstoneKey = this.tombstoneKey();
    const user = await this.db.prepare('SELECT id,email,clerk_user_id,deleted_at FROM users WHERE id=?').bind(userId).first<Row>();
    if (!user) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has already been deleted');
    // A response can be lost after D1 commits. Repeating the authenticated
    // deletion is therefore a successful no-op, not a second mutation.
    if (user.deleted_at != null) return { deletedAt: text(user.deleted_at), alreadyDeleted: true };
    const owned = await this.db.prepare(`SELECT COUNT(*) AS count FROM group_members gm JOIN groups g ON g.id=gm.group_id
      WHERE gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL AND g.deleted_at IS NULL`).bind(userId).first<Row>();
    const ownedGroupCount = number(owned?.count);
    if (ownedGroupCount > 0) throw new RepositoryError('ACCOUNT_DELETION_BLOCKED', 'Transfer ownership or delete your active groups before deleting your account', { activeOwnedGroupCount: ownedGroupCount });

    const timestamp = now();
    const originalEmail = normalizeEmail(text(user.email));
    const [deletedEmailHash, deletedClerkHash] = await Promise.all([
      identityHash(originalEmail, tombstoneKey),
      user.clerk_user_id == null ? Promise.resolve(null) : identityHash(text(user.clerk_user_id), tombstoneKey),
    ]);
    const pseudonym = `deleted+${userId}@billsplit.invalid`;
    const deletionGuard = 'EXISTS (SELECT 1 FROM users deleted_user WHERE deleted_user.id=? AND deleted_user.deleted_at=?)';
    const result = await this.db.batch([
      this.db.prepare(`UPDATE users SET email=?,clerk_user_id=NULL,deleted_email_hash=?,deleted_clerk_hash=?,deleted_at=?,updated_at=?
        WHERE id=? AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM group_members gm JOIN groups g ON g.id=gm.group_id
           WHERE gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL AND g.deleted_at IS NULL)`).bind(pseudonym, deletedEmailHash, deletedClerkHash, timestamp, timestamp, userId, userId),
      this.db.prepare(`UPDATE group_members SET deleted_at=? WHERE user_id=? AND role='member' AND deleted_at IS NULL AND ${deletionGuard}`).bind(timestamp, userId, userId, timestamp),
      // Account deletion also terminally cancels this creator's active
      // templates in the same atomic batch. Existing expenses remain intact.
      this.db.prepare(`UPDATE scheduled_expenses SET status='cancelled',blocked_reason=NULL,next_occurrence_date=NULL,generation_claim_id=NULL,updated_at=?,version=version+1 WHERE created_by=? AND status!='cancelled' AND EXISTS (SELECT 1 FROM users deleted_creator WHERE deleted_creator.id=? AND deleted_creator.deleted_at=?)`).bind(timestamp, userId, userId, timestamp),
      this.db.prepare(`UPDATE group_invitations SET revoked_at=? WHERE revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL
        AND (created_by=? OR email_normalized=?) AND ${deletionGuard}`).bind(timestamp, userId, originalEmail, userId, timestamp),
      // Invitation history is retained, but the deleted account's normalized
      // email is not. Do this for every status, not only pending rows.
      // Keep invitation history useful without leaving a contact address or
      // using a stable account-wide pseudonym. The invitation ID makes each
      // redaction distinct and the reserved .invalid TLD prevents delivery.
      this.db.prepare(`UPDATE group_invitations SET email_normalized='deleted+'||id||'@billsplit.invalid' WHERE email_normalized=? AND ${deletionGuard}`).bind(originalEmail, userId, timestamp),
      this.db.prepare(`DELETE FROM category_preferences WHERE user_id=? AND ${deletionGuard}`).bind(userId, userId, timestamp),
      this.db.prepare(`DELETE FROM idempotency_keys WHERE user_id=? AND ${deletionGuard}`).bind(userId, userId, timestamp),
      this.db.prepare(`UPDATE people SET name='Deleted account',email=NULL,user_id=NULL,deleted_at=? WHERE user_id=? AND deleted_at IS NULL AND ${deletionGuard}`).bind(timestamp, userId, userId, timestamp),
    ]);
    if (Number((result[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 0) {
      const currentOwned = await this.db.prepare(`SELECT COUNT(*) AS count FROM group_members gm JOIN groups g ON g.id=gm.group_id
        WHERE gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL AND g.deleted_at IS NULL`).bind(userId).first<Row>();
      const currentOwnedCount = number(currentOwned?.count);
      if (currentOwnedCount > 0) throw new RepositoryError('ACCOUNT_DELETION_BLOCKED', 'Transfer ownership or delete your active groups before deleting your account', { activeOwnedGroupCount: currentOwnedCount });
      throw new RepositoryError('CONFLICT', 'The account changed before deletion could complete');
    }
    return { deletedAt: timestamp };
  }

  /**
   * Resolve a verified Clerk session without changing the application's
   * existing user/person IDs. The Clerk ID is authoritative after the first
   * successful link; the email is used only for that initial link.
   */
  async userForClerk(clerkUserId: string, rawEmail: string) {
    const clerkId = clerkUserId.trim();
    const email = rawEmail.trim().toLowerCase();
    if (!clerkId || !email) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'The verified Clerk identity could not be linked safely');
    const tombstoneKey = this.tombstoneKey();
    const [clerkHash, emailHash] = await Promise.all([identityHash(clerkId, tombstoneKey), identityHash(email, tombstoneKey)]);

    const mapped = await this.db.prepare('SELECT * FROM users WHERE clerk_user_id=?').bind(clerkId).first<Row>();
    if (mapped?.deleted_at != null) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot be linked again');
    if (mapped) return this.personForUser(mapped, text(mapped.email).toLowerCase());
    const deletedIdentity = await this.db.prepare(`SELECT id FROM users WHERE deleted_at IS NOT NULL AND (deleted_clerk_hash=? OR deleted_email_hash=?)`).bind(clerkHash, emailHash).first<Row>();
    if (deletedIdentity) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot be linked again');

    const byEmail = await this.db.prepare('SELECT * FROM users WHERE lower(email)=? AND deleted_at IS NULL').bind(email).first<Row>();
    if (byEmail?.clerk_user_id != null && String(byEmail.clerk_user_id) !== clerkId) {
      throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This email is already linked to another Clerk identity');
    }

    const t = now();
    if (byEmail) {
      try {
        // D1 batches are atomic. The conditional predicate makes a concurrent
        // first-link loser observable when the mapping is read back below.
      await this.db.batch([this.db.prepare('UPDATE users SET clerk_user_id=?,updated_at=? WHERE id=? AND clerk_user_id IS NULL AND deleted_at IS NULL').bind(clerkId, t, byEmail.id)]);
      } catch (error) {
        if (!Repository.isUnique(error)) throw error;
      }
      const linked = await this.db.prepare('SELECT * FROM users WHERE id=?').bind(byEmail.id).first<Row>();
      if (!linked || String(linked.clerk_user_id) !== clerkId) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'The existing email mapping changed; the Clerk identity was not linked');
      return this.personForUser(linked, text(linked.email).toLowerCase(), t);
    }

    const id = uid();
    try {
      await this.db.batch([this.db.prepare('INSERT INTO users(id,email,clerk_user_id,created_at,updated_at) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM users deleted_user WHERE deleted_user.deleted_at IS NOT NULL AND (deleted_user.deleted_clerk_hash=? OR deleted_user.deleted_email_hash=?))').bind(id, email, clerkId, t, t, clerkHash, emailHash)]);
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

  /** Narrow recovery lookup used only to make a committed account deletion retryable. */
  async deletedAccountForIdentity(clerkUserId: string, rawEmail: string) {
    // Email is intentionally not a recovery credential. It may have changed
    // on the provider, and an unrelated Clerk identity must never be able to
    // target a deleted account merely by presenting its old email address.
    const clerkId = clerkUserId.trim();
    if (!clerkId) return null;
    const key = this.tombstoneKey();
    const clerkHash = await identityHash(clerkId, key);
    void rawEmail;
    return this.db.prepare('SELECT id,deleted_at FROM users WHERE deleted_at IS NOT NULL AND deleted_clerk_hash=?').bind(clerkHash).first<Row>();
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
    const rows = (await this.db.prepare('SELECT p.id AS person_id,p.name,p.email,gm.joined_at,gm.role,gm.user_id IS NOT NULL AS linked FROM people p JOIN group_members gm ON gm.person_id=p.id WHERE gm.group_id=? AND gm.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY p.name').bind(groupId).all<Row>()).results;
    return rows.map((row) => ({ personId: text(row.person_id), name: text(row.name), email: row.email == null ? null : text(row.email), joinedAt: text(row.joined_at), role: text(row.role) === 'owner' ? 'owner' : 'member', linked: flag(row.linked) }));
  }
  async allMembers(groupId: string): Promise<GroupMember[]> {
    const rows = (await this.db.prepare("SELECT p.id AS person_id,COALESCE(p.name,'Deleted account') AS name,p.email,gm.joined_at,gm.role,gm.deleted_at,gm.user_id IS NOT NULL AS linked FROM people p JOIN group_members gm ON gm.person_id=p.id WHERE gm.group_id=? ORDER BY p.name").bind(groupId).all<Row>()).results;
    return rows.map((row) => ({ personId: text(row.person_id), name: text(row.name), email: row.email == null ? null : text(row.email), joinedAt: text(row.joined_at), role: text(row.role) === 'owner' ? 'owner' : 'member', linked: flag(row.linked), removedAt: row.deleted_at == null ? null : text(row.deleted_at) }));
  }
  async historicalParticipants(groupId: string) {
    const rows = (await this.db.prepare("SELECT p.id AS person_id,COALESCE(p.name,'Deleted account') AS name,gm.joined_at,gm.role,gm.deleted_at AS membership_deleted_at,p.deleted_at AS person_deleted_at,gm.user_id IS NOT NULL AS linked FROM people p JOIN group_members gm ON gm.person_id=p.id WHERE gm.group_id=? ORDER BY p.name,p.id").bind(groupId).all<Row>()).results;
    return rows.map((row) => ({
      personId: text(row.person_id), name: text(row.name), joinedAt: text(row.joined_at),
      role: text(row.role) === 'owner' ? 'owner' as const : 'member' as const, linked: flag(row.linked),
      removedAt: row.membership_deleted_at == null ? null : text(row.membership_deleted_at),
      status: row.person_deleted_at != null ? 'deleted' as const : row.membership_deleted_at != null ? 'removed' as const : 'active' as const,
    }));
  }
  async groupPeople(groupId: string): Promise<string[]> {
    // Settlement endpoints are historical ledger identities. Unlike expense
    // participants, a removed or deleted person remains selectable so a
    // correction can preserve the original financial relationship.
    const rows = (await this.db.prepare('SELECT gm.person_id FROM people p JOIN group_members gm ON gm.person_id=p.id WHERE gm.group_id=?').bind(groupId).all<Row>()).results;
    return rows.map((row) => text(row.person_id));
  }
  private mapGroupSplitDefault(row: Row | null): GroupSplitDefault | null {
    if (!row) return null;
    try {
      const personIds = JSON.parse(text(row.person_ids_json));
      const values = row.values_json == null ? undefined : JSON.parse(text(row.values_json));
      const parsed = groupSplitDefaultInput.safeParse({ method: text(row.method), person_ids: personIds, ...(values === undefined ? {} : { values }) });
      if (!parsed.success) return null;
      return { method: parsed.data.method, personIds: [...parsed.data.person_ids], ...('values' in parsed.data ? { values: [...parsed.data.values] } : {}) } as GroupSplitDefault;
    } catch { return null; }
  }
  async getGroupSplitDefault(groupId: string): Promise<GroupSplitDefault | null> {
    const row = await this.db.prepare('SELECT d.* FROM group_split_defaults d JOIN groups g ON g.id=d.group_id WHERE d.group_id=? AND g.deleted_at IS NULL').bind(groupId).first<Row>();
    return this.mapGroupSplitDefault(row);
  }
  async upsertGroupSplitDefault(groupId: string, userId: string, input: GroupSplitDefaultInput): Promise<GroupSplitDefault> {
    const parsed = groupSplitDefaultInput.safeParse(input);
    if (!parsed.success) throw new RepositoryError('INVALID_SPLIT_DEFAULT', parsed.error.issues[0]?.message || 'The group split default is invalid');
    const value = parsed.data;
    const personIds = value.person_ids, timestamp = now();
    const values = 'values' in value ? value.values : undefined;
    const result = await this.db.prepare(`INSERT INTO group_split_defaults(group_id,method,person_ids_json,values_json,updated_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM groups g WHERE g.id=? AND g.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM group_members owner_member JOIN users owner_user ON owner_user.id=owner_member.user_id
        WHERE owner_member.group_id=? AND owner_member.user_id=? AND owner_member.role='owner' AND owner_member.deleted_at IS NULL AND owner_user.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS (SELECT 1 FROM group_members gm JOIN people p ON p.id=gm.person_id
        WHERE gm.group_id=? AND gm.person_id=requested.value AND gm.deleted_at IS NULL AND p.deleted_at IS NULL))
      ON CONFLICT(group_id) DO UPDATE SET method=excluded.method,person_ids_json=excluded.person_ids_json,values_json=excluded.values_json,updated_at=excluded.updated_at`).bind(groupId, value.method, JSON.stringify(personIds), values === undefined ? null : JSON.stringify(values), timestamp, groupId, groupId, userId, JSON.stringify(personIds), groupId).run();
    if (Number(result.meta?.changes ?? 0) === 0) {
      await this.throwIfDeleted(userId);
      const owner = await this.db.prepare("SELECT 1 FROM groups g JOIN group_members gm ON gm.group_id=g.id JOIN users u ON u.id=gm.user_id WHERE g.id=? AND g.deleted_at IS NULL AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL AND u.deleted_at IS NULL").bind(groupId, userId).first<Row>();
      if (!owner) throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can update the split default');
      throw new RepositoryError('MEMBER_REQUIRED', 'Every split-default participant must be an active group member');
    }
    const saved = await this.getGroupSplitDefault(groupId);
    if (!saved) throw new RepositoryError('DATABASE_ERROR', 'The group split default could not be read');
    return saved;
  }
  async deleteGroupSplitDefault(groupId: string, userId: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM group_split_defaults WHERE group_id=? AND EXISTS (SELECT 1 FROM groups g JOIN group_members gm ON gm.group_id=g.id JOIN users u ON u.id=gm.user_id WHERE g.id=? AND g.deleted_at IS NULL AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL AND u.deleted_at IS NULL)").bind(groupId, groupId, userId).run();
    if (Number(result.meta?.changes ?? 0) === 0) {
      await this.throwIfDeleted(userId);
      const owner = await this.db.prepare("SELECT 1 FROM groups g JOIN group_members gm ON gm.group_id=g.id JOIN users u ON u.id=gm.user_id WHERE g.id=? AND g.deleted_at IS NULL AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL AND u.deleted_at IS NULL").bind(groupId, userId).first<Row>();
      if (!owner) throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can delete the split default');
    }
    return Number(result.meta?.changes ?? 0) > 0;
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
      this.db.prepare("INSERT INTO group_invitations(id,group_id,email_normalized,created_by,created_at,expires_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM groups g JOIN group_members gm ON gm.group_id=g.id JOIN users owner_user ON owner_user.id=gm.user_id WHERE g.id=? AND g.deleted_at IS NULL AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL AND owner_user.deleted_at IS NULL)").bind(id, groupId, normalized, userId, t, expires, groupId, userId),
    ]);
    if (result.length && Number((result[0] as { meta?: { changes?: number } }).meta?.changes) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can create invitations'); }
    const created = await this.db.prepare('SELECT * FROM group_invitations WHERE id=?').bind(id).first<Row>();
    if (!created) throw new RepositoryError('DATABASE_ERROR', 'The invitation could not be created');
    return this.mapInvitation(created);
  }
  async revokeInvitation(groupId: string, invitationId: string, userId: string): Promise<boolean> {
    const result = await this.db.prepare("UPDATE group_invitations SET revoked_at=? WHERE id=? AND group_id=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND EXISTS (SELECT 1 FROM group_members gm JOIN users owner_user ON owner_user.id=gm.user_id WHERE gm.group_id=? AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL AND owner_user.deleted_at IS NULL)").bind(now(), invitationId, groupId, groupId, userId).run();
    if (Number(result.meta?.changes ?? 0) === 0) await this.throwIfDeleted(userId);
    return Number(result.meta?.changes ?? 0) > 0;
  }
  async acceptInvitation(invitationId: string, userId: string): Promise<GroupInvitation> {
    const user = await this.db.prepare('SELECT * FROM users WHERE id=?').bind(userId).first<Row>();
    if (!user) throw new RepositoryError('INVITATION_INVALID', 'The authenticated user is not available');
    if (user.deleted_at != null) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot accept invitations');
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
      this.db.prepare("UPDATE group_invitations SET accepted_at=?,accepted_by=? WHERE id=? AND email_normalized=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND expires_at>? AND EXISTS (SELECT 1 FROM groups WHERE id=? AND deleted_at IS NULL) AND EXISTS (SELECT 1 FROM users accept_user WHERE accept_user.id=? AND accept_user.deleted_at IS NULL)").bind(t, userId, invitationId, email, t, groupId, userId),
      ...(linkedPerson ? [] : [this.db.prepare("INSERT INTO people(id,name,email,user_id,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND accepted_by=? AND accepted_at IS NOT NULL) AND EXISTS (SELECT 1 FROM users accept_user WHERE accept_user.id=? AND accept_user.deleted_at IS NULL)").bind(personId, email.split('@')[0], email, userId, t, invitationId, userId, userId)]),
      this.db.prepare("UPDATE group_members SET user_id=?,deleted_at=NULL,role='member' WHERE group_id=? AND person_id=? AND EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND accepted_by=? AND accepted_at IS NOT NULL) AND EXISTS (SELECT 1 FROM users accept_user WHERE accept_user.id=? AND accept_user.deleted_at IS NULL)").bind(userId, groupId, personId, invitationId, userId, userId),
      this.db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) SELECT ?,?,?,?,'member' WHERE EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND accepted_by=? AND accepted_at IS NOT NULL) AND EXISTS (SELECT 1 FROM users accept_user WHERE accept_user.id=? AND accept_user.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM group_members WHERE group_id=? AND person_id=? )").bind(groupId, personId, userId, t, invitationId, userId, userId, groupId, personId),
    ];
    const result = await this.db.batch(statements);
    if (Number((result[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('CONFLICT', 'The invitation changed before it could be accepted'); }
    const accepted = await this.db.prepare('SELECT * FROM group_invitations WHERE id=?').bind(invitationId).first<Row>();
    if (!accepted) throw new RepositoryError('DATABASE_ERROR', 'The accepted invitation could not be read');
    return this.mapInvitation(accepted);
  }
  async rejectInvitation(invitationId: string, userId: string): Promise<boolean> {
    const user = await this.db.prepare('SELECT email FROM users WHERE id=?').bind(userId).first<Row>();
    if (!user) return false;
    if (user.deleted_at != null) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot reject invitations');
    const result = await this.db.prepare("UPDATE group_invitations SET rejected_at=? WHERE id=? AND email_normalized=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND expires_at>? AND EXISTS (SELECT 1 FROM users reject_user WHERE reject_user.id=? AND reject_user.deleted_at IS NULL)").bind(now(), invitationId, normalizeEmail(text(user.email)), now(), userId).run();
    if (Number(result.meta?.changes ?? 0) === 0) await this.throwIfDeleted(userId);
    return Number(result.meta?.changes ?? 0) > 0;
  }

  private membershipEventInsert(event: { id?: string; groupId: string; eventType: 'owner_transfer' | 'member_leave' | 'member_remove'; actorId: string; subjectPersonId?: string; occurredAt: string; where: string; whereArgs: unknown[] }) {
    const targetJoin = event.subjectPersonId === undefined
      ? 'JOIN group_members target ON target.group_id=actor.group_id AND target.person_id=actor.person_id'
      : 'JOIN group_members target ON target.group_id=actor.group_id AND target.person_id=?';
    const targetArgs = event.subjectPersonId === undefined ? [] : [event.subjectPersonId];
    const differentTarget = event.subjectPersonId === undefined ? '' : ' AND target.person_id != actor.person_id';
    const newRole = event.eventType === 'owner_transfer' ? 'owner' : null;
    const previousRole = 'target.role';
    return this.db.prepare(`INSERT INTO group_membership_events(id,group_id,event_type,actor_id,actor_person_id,actor_name,subject_person_id,subject_name,previous_role,new_role,occurred_at)
      SELECT ?,?,?,?,actor.person_id,COALESCE(actor_person.name,'Unknown user'),target.person_id,COALESCE(target_person.name,'Unknown member'),${previousRole},?,?
      FROM groups group_row
      JOIN group_members actor ON actor.group_id=group_row.id
      JOIN people actor_person ON actor_person.id=actor.person_id
      ${targetJoin}
      JOIN people target_person ON target_person.id=target.person_id
       WHERE group_row.id=? AND group_row.deleted_at IS NULL AND actor.user_id=? AND actor.deleted_at IS NULL AND actor_person.deleted_at IS NULL AND target.deleted_at IS NULL AND target_person.deleted_at IS NULL AND EXISTS (SELECT 1 FROM users actor_user WHERE actor_user.id=actor.user_id AND actor_user.deleted_at IS NULL)${differentTarget} AND ${event.where}`)
      .bind(event.id ?? uid(), event.groupId, event.eventType, event.actorId, newRole, event.occurredAt, ...targetArgs, event.groupId, event.actorId, ...event.whereArgs);
  }

  async removeMember(groupId: string, personId: string, userId: string): Promise<boolean> {
    const timestamp = now(), eventId = uid();
    const removalAuthorization = "actor.role='owner' AND target.deleted_at IS NULL AND target_person.deleted_at IS NULL AND EXISTS (SELECT 1 FROM users removal_actor WHERE removal_actor.id=actor.user_id AND removal_actor.deleted_at IS NULL) AND (target.role!='owner' OR (SELECT COUNT(*) FROM group_members owners WHERE owners.group_id=? AND owners.role='owner' AND owners.deleted_at IS NULL)>1)";
    const result = await this.db.batch([
      this.membershipEventInsert({ id: eventId, groupId, eventType: 'member_remove', actorId: userId, subjectPersonId: personId, occurredAt: timestamp, where: removalAuthorization, whereArgs: [groupId] }),
       this.db.prepare("UPDATE group_members SET deleted_at=? WHERE group_id=? AND person_id=? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM groups g WHERE g.id=? AND g.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM group_members actor JOIN people actor_person ON actor_person.id=actor.person_id WHERE actor.group_id=? AND actor.user_id=? AND actor.role='owner' AND actor.deleted_at IS NULL AND actor_person.deleted_at IS NULL AND EXISTS (SELECT 1 FROM users removal_actor WHERE removal_actor.id=actor.user_id AND removal_actor.deleted_at IS NULL)) AND EXISTS (SELECT 1 FROM people target_person WHERE target_person.id=? AND target_person.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM group_members self WHERE self.group_id=? AND self.person_id=? AND self.user_id=?) AND (role!='owner' OR (SELECT COUNT(*) FROM group_members owners WHERE owners.group_id=? AND owners.role='owner' AND owners.deleted_at IS NULL)>1)").bind(timestamp, groupId, personId, groupId, groupId, userId, personId, groupId, personId, userId, groupId),
       // Only the removed creator's templates are cancelled. Other members'
       // templates remain valid even when they include the removed person as a
       // payer or split (participant validity is enforced separately).
        this.db.prepare("UPDATE scheduled_expenses SET status='cancelled',blocked_reason=NULL,next_occurrence_date=NULL,generation_claim_id=NULL,updated_at=?,version=version+1 WHERE group_id=? AND status!='cancelled' AND created_by=(SELECT removed_member.user_id FROM group_members removed_member WHERE removed_member.group_id=? AND removed_member.person_id=? AND removed_member.deleted_at=?) AND EXISTS (SELECT 1 FROM group_membership_events removal_event WHERE removal_event.id=? AND removal_event.group_id=? AND removal_event.event_type='member_remove' AND removal_event.actor_id=? AND removal_event.subject_person_id=?)").bind(timestamp, groupId, groupId, personId, timestamp, eventId, groupId, userId, personId),
       this.db.prepare("UPDATE group_invitations SET revoked_at=? WHERE group_id=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND email_normalized=(SELECT lower(p.email) FROM people p WHERE p.id=? AND p.email IS NOT NULL) AND EXISTS (SELECT 1 FROM groups g WHERE g.id=? AND g.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM group_members owner_member WHERE owner_member.group_id=? AND owner_member.user_id=? AND owner_member.role='owner' AND owner_member.deleted_at IS NULL AND EXISTS (SELECT 1 FROM users removal_actor WHERE removal_actor.id=owner_member.user_id AND removal_actor.deleted_at IS NULL)) AND EXISTS (SELECT 1 FROM group_members removed_member WHERE removed_member.group_id=? AND removed_member.person_id=? AND removed_member.deleted_at=? ) AND EXISTS (SELECT 1 FROM group_membership_events removal_event WHERE removal_event.id=? AND removal_event.group_id=? AND removal_event.event_type='member_remove' AND removal_event.actor_id=? AND removal_event.subject_person_id=?)").bind(timestamp, groupId, personId, groupId, groupId, userId, groupId, personId, timestamp, eventId, groupId, userId, personId),
    ]);
    const memberChanges = Number((result[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
    if (memberChanges === 0) {
      await this.throwIfDeleted(userId);
      const selfRemoval = await this.db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND person_id=? AND user_id=? AND deleted_at IS NULL').bind(groupId, personId, userId).first<Row>();
      if (selfRemoval) throw new RepositoryError('MEMBER_REQUIRED', 'An owner cannot remove their own membership');
      const target = await this.db.prepare('SELECT role,deleted_at FROM group_members WHERE group_id=? AND person_id=?').bind(groupId, personId).first<Row>();
      if (target?.role === 'owner' && target.deleted_at == null) throw new RepositoryError('FINAL_OWNER', 'The final active owner cannot be removed');
      throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can remove members');
    }
    return true;
  }

  /**
   * Transfer ownership and record the event in one D1 transaction. The
   * precondition is repeated by both statements so a stale or racing request
   * cannot create an audit row or change a membership without the other.
   */
  async transferOwnership(groupId: string, targetPersonId: string, userId: string): Promise<boolean> {
    const timestamp = now(), eventId = uid();
    const result = await this.db.batch([
       this.membershipEventInsert({ id: eventId, groupId, eventType: 'owner_transfer', actorId: userId, subjectPersonId: targetPersonId, occurredAt: timestamp, where: "actor.role='owner' AND target.role='member' AND target.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM users target_user WHERE target_user.id=target.user_id AND target_user.deleted_at IS NULL) AND (SELECT COUNT(*) FROM group_members owners WHERE owners.group_id=? AND owners.role='owner' AND owners.deleted_at IS NULL)=1", whereArgs: [groupId] }),
       this.db.prepare("UPDATE group_members SET role='member' WHERE group_id=? AND user_id=? AND role='owner' AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM groups g WHERE g.id=? AND g.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM group_members target WHERE target.group_id=? AND target.person_id=? AND target.role='member' AND target.user_id IS NOT NULL AND target.deleted_at IS NULL AND EXISTS (SELECT 1 FROM users target_user WHERE target_user.id=target.user_id AND target_user.deleted_at IS NULL)) AND (SELECT COUNT(*) FROM group_members owners WHERE owners.group_id=? AND owners.role='owner' AND owners.deleted_at IS NULL)=1 AND EXISTS (SELECT 1 FROM users actor_user WHERE actor_user.id=? AND actor_user.deleted_at IS NULL)").bind(groupId, userId, groupId, groupId, targetPersonId, groupId, userId),
       this.db.prepare("UPDATE group_members SET role='owner' WHERE group_id=? AND person_id=? AND role='member' AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM groups g WHERE g.id=? AND g.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM group_members actor WHERE actor.group_id=? AND actor.user_id=? AND actor.role='member' AND actor.deleted_at IS NULL) AND (SELECT COUNT(*) FROM group_members owners WHERE owners.group_id=? AND owners.role='owner' AND owners.deleted_at IS NULL)=0 AND EXISTS (SELECT 1 FROM group_membership_events event WHERE event.id=? AND event.group_id=? AND event.event_type='owner_transfer' AND event.actor_id=? AND event.subject_person_id=? AND event.occurred_at=?) AND EXISTS (SELECT 1 FROM users actor_user WHERE actor_user.id=? AND actor_user.deleted_at IS NULL)").bind(groupId, targetPersonId, groupId, groupId, userId, groupId, eventId, groupId, userId, targetPersonId, timestamp, userId),
    ]);
    const changes = Number((result[2] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
    if (changes > 0) return true;
    await this.throwIfDeleted(userId);
    const actor = await this.db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=? AND deleted_at IS NULL').bind(groupId, userId).first<Row>();
    if (text(actor?.role) !== 'owner') throw new RepositoryError('OWNER_REQUIRED', 'Only the active group owner can transfer ownership');
    throw new RepositoryError('MEMBER_REQUIRED', 'Ownership can only be transferred to an active linked member');
  }

  /** Leave is deliberately self-scoped: the authenticated user is the only
   * membership row this operation can soft-remove. */
  async leaveGroup(groupId: string, userId: string): Promise<boolean> {
    const timestamp = now(), eventId = uid();
    const result = await this.db.batch([
      this.membershipEventInsert({ id: eventId, groupId, eventType: 'member_leave', actorId: userId, subjectPersonId: undefined, occurredAt: timestamp, where: "actor.role='member'", whereArgs: [] }),
       this.db.prepare("UPDATE group_members SET deleted_at=? WHERE group_id=? AND user_id=? AND role='member' AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM groups g WHERE g.id=? AND g.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM users leave_user WHERE leave_user.id=? AND leave_user.deleted_at IS NULL)").bind(timestamp, groupId, userId, groupId, userId),
       this.db.prepare("UPDATE scheduled_expenses SET status='cancelled',blocked_reason=NULL,next_occurrence_date=NULL,generation_claim_id=NULL,updated_at=?,version=version+1 WHERE group_id=? AND status!='cancelled' AND created_by=? AND EXISTS (SELECT 1 FROM group_members left_member WHERE left_member.group_id=? AND left_member.user_id=? AND left_member.role='member' AND left_member.deleted_at=?) AND EXISTS (SELECT 1 FROM group_membership_events leave_event WHERE leave_event.id=? AND leave_event.group_id=? AND leave_event.event_type='member_leave' AND leave_event.actor_id=?)").bind(timestamp, groupId, userId, groupId, userId, timestamp, eventId, groupId, userId),
        this.db.prepare("UPDATE group_invitations SET revoked_at=? WHERE group_id=? AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND (email_normalized=(SELECT lower(p.email) FROM people p JOIN group_members member ON member.person_id=p.id WHERE member.group_id=? AND member.user_id=? AND member.role='member' AND member.deleted_at=? AND p.email IS NOT NULL) OR email_normalized=(SELECT lower(email) FROM users WHERE id=?)) AND EXISTS (SELECT 1 FROM users leave_user WHERE leave_user.id=? AND leave_user.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM group_members removed_member WHERE removed_member.group_id=? AND removed_member.user_id=? AND removed_member.role='member' AND removed_member.deleted_at=?) AND EXISTS (SELECT 1 FROM group_membership_events removal_event WHERE removal_event.id=? AND removal_event.group_id=? AND removal_event.event_type='member_leave' AND removal_event.actor_id=?)").bind(timestamp, groupId, groupId, userId, timestamp, userId, userId, groupId, userId, timestamp, eventId, groupId, userId),
     ]);
     const changes = Number((result[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
    if (changes > 0) return true;
    await this.throwIfDeleted(userId);
    const current = await this.db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=? AND deleted_at IS NULL').bind(groupId, userId).first<Row>();
    if (text(current?.role) === 'owner') throw new RepositoryError('MEMBER_REQUIRED', 'An owner must transfer ownership or delete the group before leaving');
    throw new RepositoryError('MEMBER_REQUIRED', 'You are not an active member of this group');
  }
  async leaveMember(groupId: string, userId: string) { return this.leaveGroup(groupId, userId); }
  async createGroup(userId: string, personId: string, input: { name: string; currency: string }) {
    const id = uid(), t = now(), queueTime = Date.now();
    const activeUser = this.activeUserGuard(userId);
    const createdGroup = `EXISTS (SELECT 1 FROM groups created_group WHERE created_group.id=? AND created_group.name=? AND created_group.currency=? AND created_group.created_at=? AND created_group.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM group_members created_owner WHERE created_owner.group_id=? AND created_owner.person_id=? AND created_owner.user_id=? AND created_owner.role='owner' AND created_owner.deleted_at IS NULL)`;
    const result = await this.db.batch([
       this.db.prepare(`INSERT INTO groups(id,name,currency,created_at,updated_at) SELECT ?,?,?,?,? WHERE ${activeUser.sql}`).bind(id, input.name, input.currency, t, t, ...activeUser.args),
      this.db.prepare(`INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) SELECT ?,?,?,?,'owner' WHERE ${activeUser.sql} AND EXISTS (SELECT 1 FROM groups WHERE id=? AND created_at=? AND deleted_at IS NULL)`).bind(id, personId, userId, t, ...activeUser.args, id, t),
          this.db.prepare(`INSERT INTO ledger_summary_state(group_id,status,maintenance_due,available_at_ms,checkpoint_through,discovery_complete,updated_at) SELECT ?,'ready',0,?,?,1,? WHERE ${activeUser.sql} AND ${createdGroup} ON CONFLICT(group_id) DO UPDATE SET status='ready',maintenance_due=0,available_at_ms=excluded.available_at_ms,checkpoint_through=excluded.checkpoint_through,discovery_complete=1,updated_at=excluded.updated_at`).bind(id, queueTime, previousMonth(t.slice(0, 10)), t, ...activeUser.args, id, input.name, input.currency, t, id, personId, userId),
         this.db.prepare(`INSERT INTO projection_state(group_id,status,backfill_cursor,updated_at,ledger_totals_ready,reconciliation_due) SELECT ?,'ready',NULL,?,1,0 WHERE ${activeUser.sql} AND ${createdGroup} ON CONFLICT(group_id) DO NOTHING`).bind(id, t, ...activeUser.args, id, input.name, input.currency, t, id, personId, userId),
    ]);
    if (Number((result[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot create a group');
    return this.group(id, userId);
  }
  async createFriend(userId: string, personId: string, input: { name: string; email?: string | null; currency: string; client_operation_id?: string }) {
    const name = input.name.trim(), email = input.email?.trim().toLowerCase() || null;
    const linkedUser = email ? await this.db.prepare('SELECT email FROM users WHERE id=?').bind(userId).first<Row>() : null;
    const creator = await this.db.prepare('SELECT * FROM people WHERE id=? AND deleted_at IS NULL').bind(personId).first<Row>();
    if (email && (text(linkedUser?.email).toLowerCase() === email || text(creator?.email).toLowerCase() === email)) throw new RepositoryError('SELF_FRIEND', 'You cannot add your own linked person as a friend');

    const operationId = input.client_operation_id;
    const hash = stableJson({ ...input, name, email });
    const activeUser = this.activeUserGuard(userId);
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
    const id = uid(), friendId = uid(), t = now(), queueTime = Date.now();
    const create = async (target: Row | null) => {
      const targetPersonId = target ? text(target.id) : friendId;
      const targetUserId = target?.user_id == null ? null : text(target.user_id);
      const statements = [
        ...(target ? [] : [this.db.prepare(`INSERT INTO people(id,name,email,created_at) SELECT ?,?,?,? WHERE ${activeUser.sql}`).bind(friendId, name, email, t, ...activeUser.args)]),
        this.db.prepare(`INSERT INTO groups(id,name,currency,created_at,updated_at) SELECT ?,?,?,?,? WHERE ${activeUser.sql}`).bind(id, `With ${name}`, input.currency, t, t, ...activeUser.args),
        this.db.prepare(`INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) SELECT ?,?,?,?,'owner' WHERE ${activeUser.sql}`).bind(id, personId, userId, t, ...activeUser.args),
        this.db.prepare(`INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) SELECT ?,?,?,?,'member' WHERE ${activeUser.sql}`).bind(id, targetPersonId, targetUserId, t, ...activeUser.args),
         this.db.prepare(`INSERT INTO ledger_summary_state(group_id,status,maintenance_due,available_at_ms,checkpoint_through,discovery_complete,updated_at) SELECT ?,'ready',0,?,?,1,? WHERE ${activeUser.sql} AND EXISTS (SELECT 1 FROM groups WHERE id=? AND name=? AND currency=? AND created_at=? AND deleted_at IS NULL) AND EXISTS (SELECT 1 FROM group_members WHERE group_id=? AND person_id=? AND user_id=? AND role='owner' AND deleted_at IS NULL) ON CONFLICT(group_id) DO UPDATE SET status='ready',maintenance_due=0,available_at_ms=excluded.available_at_ms,checkpoint_through=excluded.checkpoint_through,discovery_complete=1,updated_at=excluded.updated_at`).bind(id, queueTime, previousMonth(t.slice(0, 10)), t, ...activeUser.args, id, `With ${name}`, input.currency, t, id, personId, userId),
         this.db.prepare(`INSERT INTO projection_state(group_id,status,backfill_cursor,updated_at,ledger_totals_ready,reconciliation_due) SELECT ?,'ready',NULL,?,1,0 WHERE ${activeUser.sql} AND EXISTS (SELECT 1 FROM groups WHERE id=? AND name=? AND currency=? AND created_at=? AND deleted_at IS NULL) AND EXISTS (SELECT 1 FROM group_members WHERE group_id=? AND person_id=? AND user_id=? AND role='owner' AND deleted_at IS NULL) ON CONFLICT(group_id) DO NOTHING`).bind(id, t, ...activeUser.args, id, `With ${name}`, input.currency, t, id, personId, userId),
        ...(operationId ? [this.db.prepare(`INSERT INTO idempotency_keys(kind,user_id,group_id,operation_id,request_hash,entity_id,created_at) SELECT ?,?,?,?,?,?,? WHERE ${activeUser.sql}`).bind('friend.create', userId, id, operationId, hash, id, t, ...activeUser.args)] : []),
      ];
      const result = await this.db.batch(statements);
      const groupIndex = target ? 0 : 1;
      if (Number((result?.[groupIndex] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot create a friend');
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
    const result = await this.db.prepare("UPDATE groups SET name=?,currency=?,updated_at=? WHERE id=? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM group_members gm JOIN users owner_user ON owner_user.id=gm.user_id WHERE gm.group_id=? AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL AND owner_user.deleted_at IS NULL)").bind(input.name, input.currency, now(), id, id, userId).run();
    if (Number(result.meta?.changes ?? 0) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can update this group'); }
    return this.group(id, userId);
  }
  async deleteGroup(id: string, userId?: string) {
    const guard = userId ? " AND EXISTS (SELECT 1 FROM group_members gm JOIN users owner_user ON owner_user.id=gm.user_id WHERE gm.group_id=? AND gm.user_id=? AND gm.role='owner' AND gm.deleted_at IS NULL AND owner_user.deleted_at IS NULL)" : '';
    const args = userId ? [now(), now(), id, id, userId] : [now(), now(), id];
    const result = await this.db.prepare(`UPDATE groups SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL${guard}`).bind(...args).run();
    if (userId && Number(result.meta?.changes ?? 0) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can delete this group'); }
  }
  async addPerson(groupId: string, person: { name: string; email?: string | null }, userId?: string, creatorPersonId?: string) {
    const id = uid(), t = now(), email = person.email?.trim().toLowerCase() ?? null;
    const ownerGuard = userId ? { sql: 'EXISTS (SELECT 1 FROM group_members owner_member WHERE owner_member.group_id=? AND owner_member.user_id=? AND owner_member.role=\'owner\' AND owner_member.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM users owner_user WHERE owner_user.id=? AND owner_user.deleted_at IS NULL)', args: [groupId, userId, userId] } : { sql: '1=1', args: [] as unknown[] };
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
          await this.throwIfDeleted(userId);
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
    if (userId && Number((result[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('OWNER_REQUIRED', 'Only an active group owner can add people'); }
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
  async scheduledExpenses(groupId: string, options: { limit?: number; offset?: number; cursor?: string } = {}) {
    if (options.cursor && options.offset !== undefined) throw new RepositoryError('INVALID_PAGINATION', 'Use either cursor or offset pagination');
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100), cursor = decodeScheduledExpenseCursor(options.cursor);
    let sql = 'SELECT * FROM scheduled_expenses WHERE group_id=?';
    const args: unknown[] = [groupId];
    if (cursor) { sql += ' AND (created_at<? OR (created_at=? AND id<?))'; args.push(cursor.createdAt, cursor.createdAt, cursor.id); }
    sql += ' ORDER BY created_at DESC,id DESC LIMIT ?'; args.push(limit + 1);
    // Offset is retained only for one grace release for already-deployed PWA
    // clients. The current client uses the cursor path above. Keep the legacy
    // path explicit rather than accepting and ignoring its offset parameter.
    if (!cursor && options.offset !== undefined) { sql += ' OFFSET ?'; args.push(Math.max(options.offset, 0)); }
    const rows = (await this.db.prepare(sql).bind(...args).all<Row>()).results;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = await this.hydrateScheduledRows(pageRows), last = pageRows[pageRows.length - 1];
    return { items, nextCursor: hasMore && last ? encodeScheduledExpenseCursor({ createdAt: text(last.created_at), id: text(last.id) }) : undefined };
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
       this.db.prepare(`INSERT INTO scheduled_expenses(id,group_id,description,amount_minor,currency,category,start_date,end_date,frequency,interval_count,weekdays_json,timezone,status,next_occurrence_date,created_by,created_at,updated_at,version,client_operation_id) SELECT ? AS id,? AS group_id,? AS description,? AS amount_minor,? AS currency,? AS category,? AS start_date,? AS end_date,? AS frequency,? AS interval_count,? AS weekdays_json,? AS timezone,? AS status,? AS next_occurrence_date,? AS created_by,? AS created_at,? AS updated_at,1 AS version,? AS client_operation_id WHERE ${actor.sql} AND ${participants.sql}`).bind(id, groupId, input.description, input.amount_minor, input.currency, input.category ?? null, input.start_date, input.end_date ?? null, input.frequency, input.interval, JSON.stringify(input.weekdays), input.timezone, status, next, userId, t, t, input.client_operation_id ? `${groupId}:${input.client_operation_id}` : null, ...actor.args, ...participants.args),
      ...this.categoryPreferenceStatements(userId, input.description, input.category, t, { table: 'scheduled_expenses', id }),
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
     const created = await this.scheduledExpense(id); if (!created) { await this.throwIfDeleted(userId); throw new RepositoryError('MEMBER_REQUIRED', 'The submitting user or a scheduled participant is no longer active'); } return created;
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
     const creator = status === 'active' ? this.activeCreatorGuard(old.groupId, old.createdBy) : { sql: '1=1', args: [] as unknown[] };
     const batchResult = await this.conditionalBatch([
       this.db.prepare(`UPDATE scheduled_expenses SET description=?,amount_minor=?,currency=?,start_date=?,end_date=?,frequency=?,interval_count=?,weekdays_json=?,timezone=?,status=?,blocked_reason=NULL,next_occurrence_date=?,generation_claim_id=?,updated_at=?,version=? WHERE id=? AND version=? AND generation_claim_id IS NULL AND ${actor.sql} AND ${participants.sql} AND ${creator.sql}`).bind(input.description, input.amount_minor, input.currency, input.start_date, input.end_date ?? null, input.frequency, input.interval, JSON.stringify(input.weekdays), input.timezone, status, next, claimId, timestamp, version, id, input.version, ...actor.args, ...participants.args, ...creator.args),
      this.db.prepare('DELETE FROM scheduled_payers WHERE scheduled_expense_id=? AND EXISTS (SELECT 1 FROM scheduled_expenses WHERE id=? AND version=? AND generation_claim_id=?)').bind(id, id, version, claimId),
      this.db.prepare('DELETE FROM scheduled_splits WHERE scheduled_expense_id=? AND EXISTS (SELECT 1 FROM scheduled_expenses WHERE id=? AND version=? AND generation_claim_id=?)').bind(id, id, version, claimId),
       ...input.payers.map((payer) => this.db.prepare('INSERT INTO scheduled_payers(scheduled_expense_id,person_id,amount_minor) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM scheduled_expenses WHERE id=? AND version=? AND generation_claim_id=?)').bind(id, payer.person_id, payer.amount_minor, id, version, claimId)),
       ...input.splits.map((split) => this.db.prepare('INSERT INTO scheduled_splits(scheduled_expense_id,person_id,amount_minor,metadata_json) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM scheduled_expenses WHERE id=? AND version=? AND generation_claim_id=?)').bind(id, split.person_id, split.amount_minor, split.metadata ? JSON.stringify(split.metadata) : null, id, version, claimId)),
       this.db.prepare('UPDATE scheduled_expenses SET category=? WHERE id=? AND version=? AND generation_claim_id=?').bind(input.category ?? null, id, version, claimId),
       ...this.categoryPreferenceStatements(userId, input.description, input.category, timestamp, { table: 'scheduled_expenses', id, version, generationClaimId: claimId }),
      this.db.prepare('UPDATE scheduled_expenses SET generation_claim_id=NULL WHERE id=? AND version=? AND generation_claim_id=?').bind(id, version, claimId),
    ]);
    const parentChanges = Number((batchResult[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes);
     if (batchResult.length && parentChanges === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('CONFLICT', 'The scheduled expense was changed or deleted by another request'); }
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
      : status === 'cancelled' ? null : before.nextOccurrenceDate;
    const storedStatus = status === 'active' && !nextOccurrence ? 'completed' : status;
     const actor = userId ? this.activeMutationGuard(before.groupId, userId) : { sql: '1=1', args: [] as unknown[] };
     const creator = storedStatus === 'active' ? this.activeCreatorGuard(before.groupId, before.createdBy) : { sql: '1=1', args: [] as unknown[] };
      const result = await this.db.prepare(`UPDATE scheduled_expenses SET status=?,blocked_reason=NULL,next_occurrence_date=?,generation_claim_id=NULL,updated_at=?,version=? WHERE id=? AND version=? AND generation_claim_id IS NULL AND ${actor.sql} AND ${creator.sql}`).bind(storedStatus, nextOccurrence, now(), version + 1, id, version, ...actor.args, ...creator.args).run();
     if (result.meta?.changes !== undefined && result.meta.changes === 0) { if (userId) await this.throwIfDeleted(userId); throw new RepositoryError('CONFLICT', 'The scheduled expense was changed or deleted by another request'); }
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
        AND EXISTS (SELECT 1 FROM users creator WHERE creator.id=schedule.created_by AND creator.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM group_members creator_member JOIN people creator_person ON creator_person.id=creator_member.person_id
          WHERE creator_member.group_id=schedule.group_id AND creator_member.user_id=schedule.created_by
            AND creator_member.deleted_at IS NULL AND creator_person.deleted_at IS NULL)
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
       guarded('INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,category,notes,created_by,created_at,updated_at,client_operation_id,version,projection_mutation_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,1,?', [id, template.groupId, expense.description, expense.amount_minor, expense.currency, expense.date, expense.category ?? null, null, template.createdBy, timestamp, timestamp, null, id]),
      guarded('INSERT INTO payers(expense_id,person_id,amount_minor) SELECT ?,json_extract(value, \'$.person_id\'),json_extract(value, \'$.amount_minor\') FROM json_each(?)', [id, JSON.stringify(expense.payers)]),
       guarded('INSERT INTO splits(expense_id,person_id,amount_minor,metadata_json) SELECT ?,json_extract(value, \'$.person_id\'),json_extract(value, \'$.amount_minor\'),json_extract(value, \'$.metadata\') FROM json_each(?)', [id, JSON.stringify(expense.splits)]),
         this.auditInsert({ groupId: template.groupId, entityType: 'expense', entityId: id, version: 1, action: 'create', actorId: template.createdBy, occurredAt: timestamp, after: this.expenseAfter(null, id, template.groupId, template.createdBy, expense, timestamp, 1), mutationMarker: id }),
         ...this.boundExpenseProjectionDelta(id, template.groupId, expense.currency, expense.payers.map((payer) => ({ personId: payer.person_id, amountMinor: payer.amount_minor })), expense.splits.map((split) => ({ personId: split.person_id, amountMinor: split.amount_minor })), 1, timestamp, undefined, expense.date),
        this.projectionMutation(template.groupId, timestamp, 'expenses', id),
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
  async generateDueScheduledExpenses(asOf: Date | string = new Date(), options: { maxTemplates?: number; maxOccurrences?: number; maxOccurrencesPerTemplate?: number; maxCleanup?: number; deadlineMs?: number } = {}) {
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
    const maxCleanup = Math.max(0, Math.min(options.maxCleanup ?? 20, 20));
    if (!withinDeadline(options.deadlineMs)) return { templatesScanned: 0, generated: 0, blocked: 0, processed: 0, capped: true };
    const utcDate = typeof asOf === 'string' ? asOf : localDateForTimeZone(asOf, 'UTC');
    const candidateThrough = typeof asOf === 'string' ? asOf : nextCalendarDate(utcDate);
    if (withinDeadline(options.deadlineMs)) await this.db.prepare("UPDATE scheduled_expenses SET status='completed',next_occurrence_date=NULL,generation_claim_id=NULL,updated_at=?,version=version+1 WHERE id IN (SELECT id FROM scheduled_expenses WHERE status='active' AND generation_claim_id IS NULL AND end_date IS NOT NULL AND end_date<=? AND (next_occurrence_date IS NULL OR next_occurrence_date>end_date) ORDER BY end_date,id LIMIT ?)").bind(now(), candidateThrough, maxCleanup).run();
    // A creator can become inactive between deployments or through an older
    // membership path. Terminally cancel those rows before selecting due
    // work, otherwise an invalid active row can remain due forever.
    if (withinDeadline(options.deadlineMs)) await this.db.prepare(`UPDATE scheduled_expenses SET status='cancelled',blocked_reason=NULL,next_occurrence_date=NULL,generation_claim_id=NULL,updated_at=?,version=version+1
      WHERE id IN (SELECT schedule.id FROM scheduled_expenses schedule
        WHERE schedule.status='active' AND (NOT EXISTS (SELECT 1 FROM users creator WHERE creator.id=schedule.created_by AND creator.deleted_at IS NULL)
          OR NOT EXISTS (SELECT 1 FROM group_members creator_member JOIN people creator_person ON creator_person.id=creator_member.person_id
            JOIN groups creator_group ON creator_group.id=creator_member.group_id
            WHERE creator_member.group_id=schedule.group_id AND creator_member.user_id=schedule.created_by
              AND creator_member.deleted_at IS NULL AND creator_person.deleted_at IS NULL AND creator_group.deleted_at IS NULL))
        ORDER BY schedule.id LIMIT ?)`).bind(now(), maxCleanup).run();
    if (!withinDeadline(options.deadlineMs)) return { templatesScanned: 0, generated: 0, blocked: 0, processed: 0, capped: true };
    const cursorRow = await this.db.prepare('SELECT cursor_id FROM scheduled_generation_cursor WHERE id=1').first<Row>();
    const cursorId = cursorRow?.cursor_id == null ? null : text(cursorRow.cursor_id);
    const rows = (await this.db.prepare(`SELECT * FROM scheduled_expenses
      WHERE status='active' AND next_occurrence_date IS NOT NULL AND start_date<=? AND next_occurrence_date<=?
        AND EXISTS (SELECT 1 FROM users creator WHERE creator.id=scheduled_expenses.created_by AND creator.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM users creator JOIN group_members creator_member ON creator_member.user_id=creator.id
          JOIN people creator_person ON creator_person.id=creator_member.person_id JOIN groups creator_group ON creator_group.id=creator_member.group_id
          WHERE creator.id=scheduled_expenses.created_by AND creator_member.group_id=scheduled_expenses.group_id
            AND creator_member.deleted_at IS NULL AND creator_person.deleted_at IS NULL AND creator_group.deleted_at IS NULL)
      ORDER BY CASE WHEN ? IS NULL OR id>? THEN 0 ELSE 1 END,id LIMIT ?`).bind(candidateThrough, candidateThrough, cursorId, cursorId, maxTemplates).all<Row>()).results;
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
        if (!withinDeadline(options.deadlineMs)) break;
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
     if (blockedTemplates.length && withinDeadline(options.deadlineMs)) await this.db.batch(blockedTemplates.map(({ template, reason }) => this.db.prepare("UPDATE scheduled_expenses SET status='blocked',blocked_reason=?,generation_claim_id=NULL,updated_at=?,version=version+1 WHERE id=? AND status='active' AND version=?").bind(reason, now(), template.id, template.version)));
    return { templatesScanned: rows.length, generated, blocked, processed, capped: processed >= maxOccurrences || states.some((state) => !state.stopped && state.processed >= maxOccurrencesPerTemplate) || !withinDeadline(options.deadlineMs) };
  }
  async expensePage(groupId: string, opts: { q?: string; person?: string; category?: string; from?: string; to?: string; currency?: string; limit: number; cursor?: string; offset?: number }) {
    if (opts.offset !== undefined) throw new RepositoryError('INVALID_PAGINATION', 'Offset pagination is no longer supported; use the cursor');
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
    const rows = (await this.db.prepare(sql).bind(...args).all<Row>()).results;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = await this.hydrateExpenses(pageRows);
    const last = pageRows[pageRows.length - 1];
    return { items, nextCursor: hasMore && last ? encodeLedgerCursor({ date: text(last.expense_date), createdAt: text(last.created_at), id: text(last.id) }) : undefined };
  }
  async transactionPage(groupId: string, opts: { kind?: Transaction['kind']; q?: string; person?: string; category?: string; from?: string; to?: string; currency?: string; limit?: number; cursor?: string; offset?: number } = {}) {
    if (opts.offset !== undefined) throw new RepositoryError('INVALID_PAGINATION', 'Offset pagination is no longer supported; use the cursor');
    assertLikeSearch(opts.q);
    for (const value of [opts.from, opts.to]) if (value !== undefined && !isCalendarDate(value)) throw new RepositoryError('INVALID_DATE', 'Date filters must be real YYYY-MM-DD dates');
    if (opts.kind !== undefined && opts.kind !== 'expense' && opts.kind !== 'settlement') throw new RepositoryError('INVALID_PAGINATION', 'Transaction kind is invalid');
    const cursor = decodeTransactionCursor(opts.cursor);
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const args: unknown[] = [groupId, groupId];
    let sql = `WITH transaction_rows AS (
      SELECT e.id,e.group_id,e.description,e.amount_minor,e.currency,e.expense_date AS transaction_date,
        e.category,e.notes,NULL AS note,NULL AS from_person_id,NULL AS to_person_id,NULL AS from_name,NULL AS to_name,
        e.created_by,e.created_at,e.client_operation_id,'expense' AS kind
      FROM expenses e WHERE e.group_id=? AND e.deleted_at IS NULL
      UNION ALL
      SELECT s.id,s.group_id,NULL,s.amount_minor,s.currency,s.settlement_date AS transaction_date,
        NULL,NULL,s.note,s.from_person_id,s.to_person_id,
        COALESCE(from_person.name,'Deleted account'),COALESCE(to_person.name,'Deleted account'),
        s.created_by,s.created_at,s.client_operation_id,'settlement' AS kind
      FROM settlements s
      LEFT JOIN people from_person ON from_person.id=s.from_person_id
      LEFT JOIN people to_person ON to_person.id=s.to_person_id
      WHERE s.group_id=? AND s.deleted_at IS NULL
    ) SELECT * FROM transaction_rows tr WHERE 1=1`;
    if (opts.kind) { sql += ' AND tr.kind=?'; args.push(opts.kind); }
    if (opts.q) { const escaped = escapedLike(opts.q); assertLikeSearch(escaped); const pattern = `%${escaped}%`; sql += " AND (tr.description LIKE ? ESCAPE '\\' OR tr.notes LIKE ? ESCAPE '\\' OR tr.note LIKE ? ESCAPE '\\')"; args.push(pattern, pattern, pattern); }
    if (opts.category) { sql += " AND tr.kind='expense' AND tr.category=?"; args.push(opts.category); }
    if (opts.currency) { sql += ' AND tr.currency=?'; args.push(opts.currency); }
    if (opts.from) { sql += ' AND tr.transaction_date>=?'; args.push(opts.from); }
    if (opts.to) { sql += ' AND tr.transaction_date<=?'; args.push(opts.to); }
    if (opts.person) {
      sql += ` AND ((tr.kind='expense' AND (tr.id IN (SELECT expense_id FROM payers WHERE person_id=?) OR tr.id IN (SELECT expense_id FROM splits WHERE person_id=?)))
        OR (tr.kind='settlement' AND (tr.from_person_id=? OR tr.to_person_id=?)))`;
      args.push(opts.person, opts.person, opts.person, opts.person);
    }
    if (cursor) {
      sql += ` AND (tr.transaction_date<? OR (tr.transaction_date=? AND tr.created_at<?)
        OR (tr.transaction_date=? AND tr.created_at=? AND (tr.kind>? OR (tr.kind=? AND tr.id<?))))`;
      args.push(cursor.date, cursor.date, cursor.createdAt, cursor.date, cursor.createdAt, cursor.kind, cursor.kind, cursor.id);
    }
    sql += ' ORDER BY tr.transaction_date DESC,tr.created_at DESC,tr.kind ASC,tr.id DESC LIMIT ?'; args.push(limit + 1);
    const rows = (await this.db.prepare(sql).bind(...args).all<Row>()).results;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items: Transaction[] = pageRows.map((row) => {
      if (text(row.kind) === 'settlement') return {
        kind: 'settlement', id: text(row.id), groupId: text(row.group_id), amountMinor: minor(row.amount_minor), currency: currency(row.currency),
        date: text(row.transaction_date), note: row.note == null ? null : text(row.note), fromPersonId: text(row.from_person_id), toPersonId: text(row.to_person_id),
        fromName: text(row.from_name), toName: text(row.to_name), createdAt: text(row.created_at),
      };
      const operation = row.client_operation_id == null ? null : (() => { const value = text(row.client_operation_id); const prefix = `${text(row.group_id)}:`; return value.startsWith(prefix) ? value.slice(prefix.length) : value; })();
      return {
        kind: 'expense', id: text(row.id), groupId: text(row.group_id), description: text(row.description), amountMinor: minor(row.amount_minor), currency: currency(row.currency),
        date: text(row.transaction_date), category: row.category == null ? null : text(row.category), notes: row.notes == null ? null : text(row.notes),
        createdBy: text(row.created_by), createdAt: text(row.created_at), clientOperationId: operation,
      };
    });
    const last = pageRows[pageRows.length - 1];
    return { items, nextCursor: hasMore && last ? encodeTransactionCursor({ date: text(last.transaction_date), createdAt: text(last.created_at), kind: text(last.kind) as Transaction['kind'], id: text(last.id) }) : undefined };
  }
  async expense(id: string, includeDeleted = false) { const row = await this.rawExpense(id); return row && (includeDeleted || !row.deleted_at) ? this.hydrateExpense(row) : null; }
  async expenseForUser(id: string, userId: string, includeDeleted = false) {
    const row = await this.db.prepare(`SELECT e.* FROM expenses e JOIN groups g ON g.id=e.group_id JOIN group_members gm ON gm.group_id=g.id
      WHERE e.id=? AND g.deleted_at IS NULL AND gm.user_id=? AND gm.deleted_at IS NULL${includeDeleted ? '' : ' AND e.deleted_at IS NULL'}`).bind(id, userId).first<Row>();
    return row ? this.hydrateExpense(row) : null;
  }
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

  private activeUserGuard(userId: string) {
    return { sql: 'EXISTS (SELECT 1 FROM users active_actor WHERE active_actor.id=? AND active_actor.deleted_at IS NULL)', args: [userId] };
  }
  private async throwIfDeleted(userId: string) {
    const user = await this.db.prepare('SELECT deleted_at FROM users WHERE id=?').bind(userId).first<Row>();
    if (user?.deleted_at != null) throw new RepositoryError('AUTH_IDENTITY_CONFLICT', 'This BillSplit account has been deleted and cannot mutate data');
  }
  private activeMutationGuard(groupId: string, userId: string) {
    return { sql: 'EXISTS (SELECT 1 FROM group_members auth_member JOIN groups auth_group ON auth_group.id=auth_member.group_id JOIN people auth_person ON auth_person.id=auth_member.person_id JOIN users auth_user ON auth_user.id=auth_member.user_id WHERE auth_member.group_id=? AND auth_member.user_id=? AND auth_member.deleted_at IS NULL AND auth_person.deleted_at IS NULL AND auth_group.deleted_at IS NULL AND auth_user.deleted_at IS NULL)', args: [groupId, userId] };
  }
  private activeCreatorGuard(groupId: string, userId: string) {
    return { sql: `EXISTS (SELECT 1 FROM users schedule_creator WHERE schedule_creator.id=? AND schedule_creator.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM group_members schedule_creator_member JOIN people schedule_creator_person ON schedule_creator_person.id=schedule_creator_member.person_id
        WHERE schedule_creator_member.group_id=? AND schedule_creator_member.user_id=? AND schedule_creator_member.deleted_at IS NULL AND schedule_creator_person.deleted_at IS NULL)`, args: [userId, groupId, userId] };
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
  private auditInsert(event: { groupId: string; entityType: 'expense' | 'settlement'; entityId: string; version: number; action: 'create' | 'update' | 'delete' | 'restore'; actorId: string; occurredAt: string; before?: unknown; after?: unknown; revisionId?: string; mutationMarker?: string }) {
    const table = event.entityType === 'expense' ? 'expenses' : 'settlements';
    // Resolve the actor's person and name in the same D1 batch as the
    // mutation. The name is a snapshot; emails are intentionally never
    // selected or written to the audit table.
    return this.db.prepare(`INSERT INTO audit_events(id,group_id,entity_type,entity_id,version,action,actor_id,actor_person_id,actor_name,occurred_at,before_json,after_json)
      SELECT ?,?,?,?,?,?,?,actor_person.id,COALESCE(actor_person.name,'Unknown user'),?,?,?
      FROM users actor_user LEFT JOIN people actor_person ON actor_person.user_id=actor_user.id AND actor_person.deleted_at IS NULL
       WHERE actor_user.id=? AND EXISTS (SELECT 1 FROM ${table} audited_entity WHERE audited_entity.id=? AND audited_entity.version=?${event.mutationMarker === undefined ? '' : ' AND audited_entity.projection_mutation_id=?'})${event.revisionId === undefined ? '' : " AND EXISTS (SELECT 1 FROM revisions audit_revision WHERE audit_revision.id=? AND audit_revision.entity_type=? AND audit_revision.entity_id=?)"}`)
       .bind(uid(), event.groupId, event.entityType, event.entityId, event.version, event.action, event.actorId, event.occurredAt, event.before == null ? null : JSON.stringify(event.before), event.after == null ? null : JSON.stringify(event.after), event.actorId, event.entityId, event.version, ...(event.mutationMarker === undefined ? [] : [event.mutationMarker]), ...(event.revisionId === undefined ? [] : [event.revisionId, event.entityType, event.entityId]));
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
       this.db.prepare(`INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,category,notes,created_by,created_at,updated_at,client_operation_id,version,projection_mutation_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,1,? WHERE ${actor.sql} AND ${participants.sql}`).bind(id, groupId, input.description, input.amount_minor, input.currency, input.date, input.category ?? null, input.notes ?? null, userId, t, t, scopedOperation ?? null, id, ...actor.args, ...participants.args),
       this.db.prepare("INSERT INTO payers(expense_id,person_id,amount_minor) SELECT ?,json_extract(value,'$.person_id'),json_extract(value,'$.amount_minor') FROM json_each(?) WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=1)").bind(id, JSON.stringify(input.payers), id),
        this.db.prepare("INSERT INTO splits(expense_id,person_id,amount_minor,metadata_json) SELECT ?,json_extract(value,'$.person_id'),json_extract(value,'$.amount_minor'),json_extract(value,'$.metadata') FROM json_each(?) WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=1)").bind(id, JSON.stringify(input.splits), id),
        ...this.categoryPreferenceStatements(userId, input.description, input.category, t, { table: 'expenses', id }),
        this.auditInsert({ groupId, entityType: 'expense', entityId: id, version: 1, action: 'create', actorId: userId, occurredAt: t, after, mutationMarker: id }),
        ...this.boundExpenseProjectionDelta(id, groupId, input.currency, input.payers.map((payer) => ({ personId: payer.person_id, amountMinor: payer.amount_minor })), input.splits.map((split) => ({ personId: split.person_id, amountMinor: split.amount_minor })), 1, t, undefined, input.date),
       this.projectionMutation(groupId, t, 'expenses', id),
    ];
    try { await this.db.batch(statements); } catch (error) {
      if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow();
      if (!input.client_operation_id || !Repository.isUnique(error)) throw error;
      const existing = await this.existingClaim('expense.create', userId, groupId, input.client_operation_id);
      if (!existing) throw error;
      if (text(existing.request_hash) !== hash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
      const found = await this.expense(text(existing.entity_id)); if (found && found.groupId === groupId) return found; throw error;
    }
     const created = await this.expense(id); if (!created) { await this.throwIfDeleted(userId); throw new RepositoryError('MEMBER_REQUIRED', 'The submitting user or a participant is no longer active'); } return created;
  }

  async updateExpense(id: string, userId: string, input: ExpenseInput) {
    if (!input.version) throw new RepositoryError('CONFLICT', 'A record version is required');
    const old = await this.expenseForUser(id, userId); if (!old) throw new RepositoryError('CONFLICT', 'The record was deleted by another request');
    if (old.version !== input.version) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
    const t = now(), next = input.version + 1, revisionId = uid(), actor = this.activeMutationGuard(old.groupId, userId), participants = this.activeParticipantGuard(old.groupId, [...input.payers, ...input.splits].map((p) => p.person_id)), after = this.expenseAfter(old, id, old.groupId, userId, input, t, next), revisionGuard = this.projectionRevisionGuard(revisionId, 'expense', id);
    const statements = [
      this.db.prepare(`UPDATE expenses SET description=?,amount_minor=?,currency=?,expense_date=?,category=?,notes=?,updated_at=?,version=?,projection_mutation_id=? WHERE id=? AND version=? AND deleted_at IS NULL AND ${actor.sql} AND ${participants.sql}`).bind(input.description, input.amount_minor, input.currency, input.date, input.category ?? null, input.notes ?? null, t, next, revisionId, id, input.version, ...actor.args, ...participants.args),
      this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=? AND projection_mutation_id=? AND deleted_at IS NULL)').bind(revisionId, 'expense', id, input.version, JSON.stringify(old), userId, t, id, next, revisionId),
       ...this.boundExpenseProjectionDelta(id, old.groupId, old.currency, old.payers, old.splits, -1, t, revisionId, old.date),
      this.db.prepare(`DELETE FROM payers WHERE expense_id=? AND ${revisionGuard.sql}`).bind(id, ...revisionGuard.args),
      this.db.prepare(`DELETE FROM splits WHERE expense_id=? AND ${revisionGuard.sql}`).bind(id, ...revisionGuard.args),
      this.db.prepare(`INSERT INTO payers(expense_id,person_id,amount_minor) SELECT ?,json_extract(value,'$.person_id'),json_extract(value,'$.amount_minor') FROM json_each(?) WHERE ${revisionGuard.sql}`).bind(id, JSON.stringify(input.payers), ...revisionGuard.args),
      this.db.prepare(`INSERT INTO splits(expense_id,person_id,amount_minor,metadata_json) SELECT ?,json_extract(value,'$.person_id'),json_extract(value,'$.amount_minor'),json_extract(value,'$.metadata') FROM json_each(?) WHERE ${revisionGuard.sql}`).bind(id, JSON.stringify(input.splits), ...revisionGuard.args),
      ...this.categoryPreferenceStatements(userId, input.description, input.category, t, { table: 'expenses', id, version: next, revisionId }),
      this.auditInsert({ groupId: old.groupId, entityType: 'expense', entityId: id, version: next, action: 'update', actorId: userId, occurredAt: t, before: old, after, revisionId, mutationMarker: revisionId }),
       ...this.boundExpenseProjectionDelta(id, old.groupId, input.currency, input.payers.map((payer) => ({ personId: payer.person_id, amountMinor: payer.amount_minor })), input.splits.map((split) => ({ personId: split.person_id, amountMinor: split.amount_minor })), 1, t, revisionId, input.date),
      this.projectionMutation(old.groupId, t, 'expenses', id, revisionId),
    ];
      const batchResult = await this.conditionalBatch(statements);
      if (Number((batchResult[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('CONFLICT', 'The record was changed by another request'); }
    const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.rawExpense(id); if (!revision || !current || number(current.version) !== next) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
    return this.hydrateExpense(current);
  }
  async deleteExpense(id: string, userId: string, version: number) {
    const old = await this.expenseForUser(id, userId); if (!old) return false; if (old.version !== version) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); const t = now(), next = version + 1, revisionId = uid(), actor = this.activeMutationGuard(old.groupId, userId);
    const batchResult = await this.conditionalBatch([
      this.db.prepare(`UPDATE expenses SET deleted_at=?,updated_at=?,version=?,projection_mutation_id=? WHERE id=? AND version=? AND deleted_at IS NULL AND ${actor.sql}`).bind(t, t, next, revisionId, id, version, ...actor.args),
      this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=? AND projection_mutation_id=? AND deleted_at IS NOT NULL)').bind(revisionId, 'expense', id, version, JSON.stringify(old), userId, t, id, next, revisionId),
       ...this.boundExpenseProjectionDelta(id, old.groupId, old.currency, old.payers, old.splits, -1, t, revisionId, old.date),
       this.auditInsert({ groupId: old.groupId, entityType: 'expense', entityId: id, version: next, action: 'delete', actorId: userId, occurredAt: t, before: old, after: null, revisionId, mutationMarker: revisionId }),
      this.projectionMutation(old.groupId, t, 'expenses', id, revisionId),
    ]);
     if (Number((batchResult[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('CONFLICT', 'The record was changed by another request'); }
     const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.rawExpense(id); if (!revision || !current || number(current.version) !== next || !current.deleted_at) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
    return true;
  }
  async restoreExpense(id: string, userId: string, version: number) {
    const old = await this.expenseForUser(id, userId, true);
    if (!old || !old.deletedAt || !this.withinRestoreWindow(old.deletedAt) || old.version !== version) throw new RepositoryError('CONFLICT', 'The deleted expense is unavailable or was changed by another request');
    const next = version + 1, t = now(), revisionId = uid(), actor = this.activeMutationGuard(old.groupId, userId), after = { ...old, deletedAt: null, updatedAt: t, version: next };
    const batchResult = await this.conditionalBatch([
      this.db.prepare(`UPDATE expenses SET deleted_at=NULL,updated_at=?,version=?,projection_mutation_id=? WHERE id=? AND version=? AND deleted_at IS NOT NULL AND ${actor.sql}`).bind(t, next, revisionId, id, version, ...actor.args),
      this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=? AND projection_mutation_id=? AND deleted_at IS NULL)').bind(revisionId, 'expense', id, next, JSON.stringify(old), userId, t, id, next, revisionId),
       ...this.boundExpenseProjectionDelta(id, old.groupId, old.currency, old.payers, old.splits, 1, t, revisionId, old.date),
       this.auditInsert({ groupId: old.groupId, entityType: 'expense', entityId: id, version: next, action: 'restore', actorId: userId, occurredAt: t, before: old, after, revisionId, mutationMarker: revisionId }),
      this.projectionMutation(old.groupId, t, 'expenses', id, revisionId),
    ]);
     if (Number((batchResult[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('CONFLICT', 'The expense changed before it could be restored'); }
     const current = await this.expense(id); if (!current || current.version !== next) throw new RepositoryError('CONFLICT', 'The expense changed before it could be restored');
    return current;
  }

  private mapSettlement(row: Row): Settlement { return { id: text(row.id), groupId: text(row.group_id), fromPersonId: text(row.from_person_id), toPersonId: text(row.to_person_id), amountMinor: minor(row.amount_minor), currency: currency(row.currency), date: text(row.settlement_date), note: row.note == null ? null : text(row.note), createdAt: text(row.created_at), updatedAt: text(row.updated_at), deletedAt: row.deleted_at == null ? null : text(row.deleted_at), version: number(row.version) || 1 }; }
  async settlementPage(groupId: string, options: { limit?: number; cursor?: string; offset?: number } = {}) {
    if (options.offset !== undefined) throw new RepositoryError('INVALID_PAGINATION', 'Offset pagination is no longer supported; use the cursor');
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100), cursor = decodeLedgerCursor(options.cursor);
    let sql = 'SELECT * FROM settlements WHERE group_id=? AND deleted_at IS NULL'; const args: unknown[] = [groupId];
    if (cursor) { sql += ' AND (settlement_date<? OR (settlement_date=? AND created_at<?) OR (settlement_date=? AND created_at=? AND id<?))'; args.push(cursor.date, cursor.date, cursor.createdAt, cursor.date, cursor.createdAt, cursor.id); }
    sql += ' ORDER BY settlement_date DESC,created_at DESC,id DESC LIMIT ?'; args.push(limit + 1);
    const rows = (await this.db.prepare(sql).bind(...args).all<Row>()).results, pageRows = rows.length > limit ? rows.slice(0, limit) : rows, last = pageRows[pageRows.length - 1];
    return { items: pageRows.map((row) => this.mapSettlement(row)), nextCursor: rows.length > limit && last ? encodeLedgerCursor({ date: text(last.settlement_date), createdAt: text(last.created_at), id: text(last.id) }) : undefined };
  }
  async settlement(id: string, includeDeleted = false) { const row = await this.db.prepare(`SELECT * FROM settlements WHERE id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`).bind(id).first<Row>(); return row ? this.mapSettlement(row) : null; }
  async settlementForUser(id: string, userId: string, includeDeleted = false) {
    const row = await this.db.prepare(`SELECT s.* FROM settlements s JOIN groups g ON g.id=s.group_id JOIN group_members gm ON gm.group_id=g.id
      WHERE s.id=? AND g.deleted_at IS NULL AND gm.user_id=? AND gm.deleted_at IS NULL${includeDeleted ? '' : ' AND s.deleted_at IS NULL'}`).bind(id, userId).first<Row>();
    return row ? this.mapSettlement(row) : null;
  }
  private settlementParticipantGuard(groupId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return { sql: '1=0', args: [] as unknown[] };
    return {
      sql: `NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS (
        SELECT 1 FROM group_members settlement_participant JOIN people settlement_person ON settlement_person.id=settlement_participant.person_id
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
       this.db.prepare(`INSERT INTO settlements(id,group_id,from_person_id,to_person_id,amount_minor,currency,settlement_date,note,created_by,created_at,updated_at,client_operation_id,version,projection_mutation_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,1,? WHERE ${actor.sql} AND ${participants.sql}`).bind(id, groupId, input.from_person_id, input.to_person_id, input.amount_minor, input.currency, input.date, input.note ?? null, userId, t, t, input.client_operation_id ? `${groupId}:${input.client_operation_id}` : null, id, ...actor.args, ...participants.args),
        this.auditInsert({ groupId, entityType: 'settlement', entityId: id, version: 1, action: 'create', actorId: userId, occurredAt: t, after, mutationMarker: id }),
         ...this.boundSettlementProjectionDelta(id, groupId, input.currency, input.from_person_id, input.to_person_id, input.amount_minor, 1, t, undefined, input.date),
        this.projectionMutation(groupId, t, 'settlements', id),
    ];
    try { await this.db.batch(statements); } catch (error) {
      if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow();
      if (!input.client_operation_id || !Repository.isUnique(error)) throw error;
      const existing = await this.existingClaim('settlement.create', userId, groupId, input.client_operation_id);
      if (!existing) throw error; if (text(existing.request_hash) !== hash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
      const found = await this.settlement(text(existing.entity_id)); if (found && found.groupId === groupId) return found; throw error;
    }
     const created = await this.settlement(id); if (!created) { await this.throwIfDeleted(userId); throw new RepositoryError('MEMBER_REQUIRED', 'The submitting user or settlement participants are not valid for this group'); } return created;
  }
  async updateSettlement(id: string, userId: string, input: SettlementInput) {
    if (!input.version) throw new RepositoryError('CONFLICT', 'A record version is required'); const old = await this.settlementForUser(id, userId); if (!old) throw new RepositoryError('CONFLICT', 'The record was deleted by another request'); if (old.version !== input.version) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); const t = now(), next = input.version + 1, revisionId = uid(), actor = this.activeMutationGuard(old.groupId, userId), participants = this.settlementParticipantGuard(old.groupId, [input.from_person_id, input.to_person_id]);
     const after: Settlement = { ...old, fromPersonId: input.from_person_id, toPersonId: input.to_person_id, amountMinor: input.amount_minor, currency: input.currency, date: input.date, note: input.note ?? null, updatedAt: t, version: next };
     const batchResult = await this.conditionalBatch([
       this.db.prepare(`UPDATE settlements SET from_person_id=?,to_person_id=?,amount_minor=?,currency=?,settlement_date=?,note=?,updated_at=?,version=?,projection_mutation_id=? WHERE id=? AND version=? AND deleted_at IS NULL AND ${actor.sql} AND ${participants.sql}`).bind(input.from_person_id, input.to_person_id, input.amount_minor, input.currency, input.date, input.note ?? null, t, next, revisionId, id, input.version, ...actor.args, ...participants.args),
       this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM settlements WHERE id=? AND version=? AND projection_mutation_id=? AND deleted_at IS NULL)').bind(revisionId, 'settlement', id, input.version, JSON.stringify(old), userId, t, id, next, revisionId),
        ...this.boundSettlementProjectionDelta(id, old.groupId, old.currency, old.fromPersonId, old.toPersonId, old.amountMinor, -1, t, revisionId, old.date),
        this.auditInsert({ groupId: old.groupId, entityType: 'settlement', entityId: id, version: next, action: 'update', actorId: userId, occurredAt: t, before: old, after, revisionId, mutationMarker: revisionId }),
        ...this.boundSettlementProjectionDelta(id, old.groupId, input.currency, input.from_person_id, input.to_person_id, input.amount_minor, 1, t, revisionId, input.date),
       this.projectionMutation(old.groupId, t, 'settlements', id, revisionId),
     ]);
     if (Number((batchResult[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('CONFLICT', 'The record was changed by another request'); }
     const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.db.prepare('SELECT * FROM settlements WHERE id=?').bind(id).first<Row>(); if (!revision || !current || number(current.version) !== next) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); return this.mapSettlement(current);
  }
  async deleteSettlement(id: string, userId: string, version: number) {
     const old = await this.settlementForUser(id, userId); if (!old) return false; if (old.version !== version) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); const t = now(), next = version + 1, revisionId = uid(), actor = this.activeMutationGuard(old.groupId, userId);
     const batchResult = await this.conditionalBatch([
        this.db.prepare(`UPDATE settlements SET deleted_at=?,updated_at=?,version=?,projection_mutation_id=? WHERE id=? AND version=? AND deleted_at IS NULL AND ${actor.sql}`).bind(t, t, next, revisionId, id, version, ...actor.args),
        this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM settlements WHERE id=? AND version=? AND projection_mutation_id=? AND deleted_at IS NOT NULL)').bind(revisionId, 'settlement', id, version, JSON.stringify(old), userId, t, id, next, revisionId),
       ...this.boundSettlementProjectionDelta(id, old.groupId, old.currency, old.fromPersonId, old.toPersonId, old.amountMinor, -1, t, revisionId, old.date),
        this.auditInsert({ groupId: old.groupId, entityType: 'settlement', entityId: id, version: next, action: 'delete', actorId: userId, occurredAt: t, before: old, after: null, revisionId, mutationMarker: revisionId }),
       this.projectionMutation(old.groupId, t, 'settlements', id, revisionId),
     ]);
     if (Number((batchResult[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('CONFLICT', 'The record was changed by another request'); }
     const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.db.prepare('SELECT * FROM settlements WHERE id=?').bind(id).first<Row>(); if (!revision || !current || number(current.version) !== next || !current.deleted_at) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); return true;
  }
  async restoreSettlement(id: string, userId: string, version: number) {
    const old = await this.settlementForUser(id, userId, true);
    if (!old || !old.deletedAt || !this.withinRestoreWindow(old.deletedAt) || old.version !== version) throw new RepositoryError('CONFLICT', 'The deleted settlement is unavailable or was changed by another request');
     const next = version + 1, t = now(), revisionId = uid(), actor = this.activeMutationGuard(old.groupId, userId), after = { ...old, deletedAt: null, updatedAt: t, version: next };
     const batchResult = await this.conditionalBatch([
       this.db.prepare(`UPDATE settlements SET deleted_at=NULL,updated_at=?,version=?,projection_mutation_id=? WHERE id=? AND version=? AND deleted_at IS NOT NULL AND ${actor.sql}`).bind(t, next, revisionId, id, version, ...actor.args),
       this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM settlements WHERE id=? AND version=? AND projection_mutation_id=? AND deleted_at IS NULL)').bind(revisionId, 'settlement', id, next, JSON.stringify(old), userId, t, id, next, revisionId),
       ...this.boundSettlementProjectionDelta(id, old.groupId, old.currency, old.fromPersonId, old.toPersonId, old.amountMinor, 1, t, revisionId, old.date),
        this.auditInsert({ groupId: old.groupId, entityType: 'settlement', entityId: id, version: next, action: 'restore', actorId: userId, occurredAt: t, before: old, after, revisionId, mutationMarker: revisionId }),
       this.projectionMutation(old.groupId, t, 'settlements', id, revisionId),
     ]);
     if (Number((batchResult[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) === 0) { await this.throwIfDeleted(userId); throw new RepositoryError('CONFLICT', 'The settlement changed before it could be restored'); }
     const current = await this.settlement(id); if (!current || current.version !== next) throw new RepositoryError('CONFLICT', 'The settlement changed before it could be restored');
    return current;
  }

  async revisions(type: string, id: string) {
    const rows = (await this.db.prepare('SELECT id,entity_type,entity_id,revision,snapshot_json,created_by,created_at FROM revisions WHERE entity_type=? AND entity_id=? ORDER BY revision DESC').bind(type, id).all<Row>()).results;
    return rows.map((row) => ({ id: text(row.id), entityType: text(row.entity_type), entityId: text(row.entity_id), revision: number(row.revision), snapshot: JSON.parse(text(row.snapshot_json)), createdBy: text(row.created_by), createdAt: text(row.created_at) }));
  }
  async auditPage(groupId: string, options: { limit?: number; cursor?: string; offset?: number } = {}) {
    if (options.offset !== undefined) throw new RepositoryError('INVALID_PAGINATION', 'Offset pagination is no longer supported; use the cursor');
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100), cursor = decodeLedgerCursor(options.cursor);
    let sql = 'SELECT id,group_id,entity_type,entity_id,version,action,actor_id,actor_person_id,actor_name,occurred_at,before_json,after_json FROM audit_events WHERE group_id=?'; const args: unknown[] = [groupId];
    if (cursor) { sql += ' AND (occurred_at<? OR (occurred_at=? AND id<?))'; args.push(cursor.createdAt, cursor.createdAt, cursor.id); }
    sql += ' ORDER BY occurred_at DESC,id DESC LIMIT ?'; args.push(limit + 1);
    const rows = (await this.db.prepare(sql).bind(...args).all<Row>()).results;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows;
    const parse = (value: unknown) => { if (value == null) return undefined; try { return JSON.parse(text(value)); } catch { return undefined; } };
    const items = pageRows.map((row) => ({ id: text(row.id), groupId: text(row.group_id), entityType: text(row.entity_type) as AuditEvent['entityType'], entityId: text(row.entity_id), version: number(row.version), action: text(row.action) as AuditEvent['action'], actorId: text(row.actor_id), ...(row.actor_person_id == null ? {} : { actorPersonId: text(row.actor_person_id) }), actorName: text(row.actor_name) || 'Unknown user', occurredAt: text(row.occurred_at), ...(row.before_json == null ? {} : { before: parse(row.before_json) }), ...(row.after_json == null ? {} : { after: parse(row.after_json) }) }));
    const last = pageRows[pageRows.length - 1];
    return { items, nextCursor: hasMore && last ? encodeLedgerCursor({ date: text(last.occurred_at), createdAt: text(last.occurred_at), id: text(last.id) }) : undefined };
  }
  async purgeExpiredData(asOf: Date | string = new Date(), options: { maxTransactions?: number; maxGroups?: number; deadlineMs?: number } = {}) {
    const current = typeof asOf === 'string' ? new Date(asOf) : asOf, cutoff = new Date(current.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Financial detail is permanent for active groups. Deleted groups are the
    // exception, and are drained in bounded, FK-safe chunks before the group
     // tombstone itself is removed. A durable (deleted_at,id) cursor provides
     // round-robin progress without sorting the whole tombstone range.
    const maxTransactions = Math.min(Math.max(options.maxTransactions ?? 8, 1), 100), maxGroups = Math.min(Math.max(options.maxGroups ?? 4, 0), 20);
     const groups = withinDeadline(options.deadlineMs) ? (await this.db.prepare(`WITH purge_cursor AS (
         SELECT deleted_at AS cursor_deleted_at,group_id AS cursor_group_id FROM group_purge_cursor WHERE id=1
       ), after_cursor AS (
         SELECT g.id,g.deleted_at,0 AS wrapped FROM groups g CROSS JOIN purge_cursor
           WHERE g.deleted_at IS NOT NULL AND g.deleted_at<?
             AND (purge_cursor.cursor_deleted_at IS NULL OR g.deleted_at>purge_cursor.cursor_deleted_at
               OR (g.deleted_at=purge_cursor.cursor_deleted_at AND g.id>purge_cursor.cursor_group_id))
           ORDER BY g.deleted_at,g.id LIMIT ?
       ), before_cursor AS (
         SELECT g.id,g.deleted_at,1 AS wrapped FROM groups g CROSS JOIN purge_cursor
           WHERE g.deleted_at IS NOT NULL AND g.deleted_at<? AND purge_cursor.cursor_deleted_at IS NOT NULL
             AND (g.deleted_at<purge_cursor.cursor_deleted_at
               OR (g.deleted_at=purge_cursor.cursor_deleted_at AND g.id<=purge_cursor.cursor_group_id))
           ORDER BY g.deleted_at,g.id LIMIT ?
       )
       SELECT id,deleted_at FROM (SELECT * FROM after_cursor UNION ALL SELECT * FROM before_cursor)
          ORDER BY wrapped,deleted_at,id LIMIT ?`).bind(cutoff, maxGroups, cutoff, maxGroups, maxGroups).all<Row>()).results
      : [] as Row[];
     let transactionsScanned = 0, transactionsPurged = 0, auditEventsPurged = 0, groupsPurged = 0, incomplete = false;
     for (const row of groups) {
       if (!withinDeadline(options.deadlineMs)) { incomplete = true; break; }
      const groupId = text(row.id);
        // Check between each bounded substep. In particular, do not start a
        // second query or batch after the shared Cron deadline has expired.
        if (!withinDeadline(options.deadlineMs)) { incomplete = true; break; }
        const expenseRows = await this.db.prepare("SELECT id,'expense' AS entity_type FROM expenses WHERE group_id=? ORDER BY id LIMIT ?").bind(groupId, maxTransactions).all<Row>();
        if (!withinDeadline(options.deadlineMs)) { incomplete = true; break; }
        const settlementRows = await this.db.prepare("SELECT id,'settlement' AS entity_type FROM settlements WHERE group_id=? ORDER BY id LIMIT ?").bind(groupId, maxTransactions).all<Row>();
       const transactions = [...expenseRows.results, ...settlementRows.results].sort((left, right) => text(left.id).localeCompare(text(right.id))).slice(0, maxTransactions);
      transactionsScanned += transactions.length;
       if (!withinDeadline(options.deadlineMs)) { incomplete = true; break; }
       const transactionResult = await this.db.batch([
         this.db.prepare(`DELETE FROM attachments WHERE id IN (SELECT attachment.id FROM attachments attachment JOIN expenses expense ON expense.id=attachment.expense_id WHERE expense.group_id=? LIMIT ?)` ).bind(groupId, maxTransactions),
        // Occurrences are both schedule children and expense FK children.
         this.db.prepare(`DELETE FROM scheduled_occurrences WHERE rowid IN (SELECT occurrence.rowid FROM scheduled_occurrences occurrence JOIN expenses expense ON expense.id=occurrence.expense_id WHERE expense.group_id=? LIMIT ?)` ).bind(groupId, maxTransactions),
         this.db.prepare(`DELETE FROM payers WHERE rowid IN (SELECT payer.rowid FROM payers payer JOIN expenses expense ON expense.id=payer.expense_id WHERE expense.group_id=? LIMIT ?)` ).bind(groupId, maxTransactions),
         this.db.prepare(`DELETE FROM splits WHERE rowid IN (SELECT split.rowid FROM splits split JOIN expenses expense ON expense.id=split.expense_id WHERE expense.group_id=? LIMIT ?)` ).bind(groupId, maxTransactions),
         this.db.prepare(`DELETE FROM revisions WHERE rowid IN (SELECT revision.rowid FROM revisions revision JOIN expenses expense ON expense.id=revision.entity_id WHERE revision.entity_type='expense' AND expense.group_id=? LIMIT ?)` ).bind(groupId, maxTransactions),
        this.db.prepare(`DELETE FROM expenses WHERE rowid IN (SELECT expense.rowid FROM expenses expense WHERE expense.group_id=?
          AND NOT EXISTS (SELECT 1 FROM attachments attachment WHERE attachment.expense_id=expense.id)
          AND NOT EXISTS (SELECT 1 FROM scheduled_occurrences occurrence WHERE occurrence.expense_id=expense.id)
          AND NOT EXISTS (SELECT 1 FROM payers payer WHERE payer.expense_id=expense.id)
          AND NOT EXISTS (SELECT 1 FROM splits split WHERE split.expense_id=expense.id)
          AND NOT EXISTS (SELECT 1 FROM revisions revision WHERE revision.entity_type='expense' AND revision.entity_id=expense.id)
           LIMIT ?)` ).bind(groupId, maxTransactions),
          this.db.prepare(`DELETE FROM revisions WHERE rowid IN (SELECT revision.rowid FROM revisions revision JOIN settlements settlement ON settlement.id=revision.entity_id WHERE revision.entity_type='settlement' AND settlement.group_id=? LIMIT ?)` ).bind(groupId, maxTransactions),
        this.db.prepare(`DELETE FROM settlements WHERE rowid IN (SELECT settlement.rowid FROM settlements settlement WHERE settlement.group_id=?
          AND NOT EXISTS (SELECT 1 FROM revisions revision WHERE revision.entity_type='settlement' AND revision.entity_id=settlement.id)
           LIMIT ?)` ).bind(groupId, maxTransactions),
          this.db.prepare(`DELETE FROM scheduled_occurrences WHERE rowid IN (SELECT occurrence.rowid FROM scheduled_occurrences occurrence JOIN scheduled_expenses schedule ON schedule.id=occurrence.scheduled_expense_id WHERE schedule.group_id=? LIMIT ?)` ).bind(groupId, maxTransactions),
          this.db.prepare(`DELETE FROM scheduled_payers WHERE rowid IN (SELECT payer.rowid FROM scheduled_payers payer JOIN scheduled_expenses schedule ON schedule.id=payer.scheduled_expense_id WHERE schedule.group_id=? LIMIT ?)` ).bind(groupId, maxTransactions),
          this.db.prepare(`DELETE FROM scheduled_splits WHERE rowid IN (SELECT split.rowid FROM scheduled_splits split JOIN scheduled_expenses schedule ON schedule.id=split.scheduled_expense_id WHERE schedule.group_id=? LIMIT ?)` ).bind(groupId, maxTransactions),
        this.db.prepare(`DELETE FROM scheduled_expenses WHERE rowid IN (SELECT schedule.rowid FROM scheduled_expenses schedule WHERE schedule.group_id=?
          AND NOT EXISTS (SELECT 1 FROM scheduled_occurrences occurrence WHERE occurrence.scheduled_expense_id=schedule.id)
          AND NOT EXISTS (SELECT 1 FROM scheduled_payers payer WHERE payer.scheduled_expense_id=schedule.id)
          AND NOT EXISTS (SELECT 1 FROM scheduled_splits split WHERE split.scheduled_expense_id=schedule.id)
           LIMIT ?)` ).bind(groupId, maxTransactions),
      ]);
      transactionsPurged += Number((transactionResult[5] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
      transactionsPurged += Number((transactionResult[7] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
       if (!withinDeadline(options.deadlineMs)) { incomplete = true; break; }
       const remainingTransaction = await this.db.prepare('SELECT 1 FROM expenses WHERE group_id=? UNION ALL SELECT 1 FROM settlements WHERE group_id=? LIMIT 1').bind(groupId, groupId).first<Row>();
       if (!withinDeadline(options.deadlineMs)) { incomplete = true; break; }
       const remainingSchedule = await this.db.prepare('SELECT 1 FROM scheduled_expenses WHERE group_id=? LIMIT 1').bind(groupId).first<Row>();
      if (remainingTransaction || remainingSchedule) {
        incomplete = true;
        await this.db.batch([
          this.db.prepare('UPDATE groups SET updated_at=? WHERE id=? AND deleted_at IS NOT NULL AND deleted_at<?').bind(now(), groupId, cutoff),
           this.db.prepare('UPDATE group_purge_cursor SET deleted_at=?,group_id=?,updated_at=? WHERE id=1').bind(text(row.deleted_at), groupId, now()),
        ]);
        continue;
      }

      // Once authoritative rows are gone, every derived/compatibility table
      // gets its own bounded rowid/key delete. Never issue an unbounded
      // group-wide DELETE: large audit/build histories must yield to Cron.
       if (!withinDeadline(options.deadlineMs)) { incomplete = true; break; }
       const metadataResult = await this.db.batch([
        this.db.prepare('DELETE FROM audit_events WHERE rowid IN (SELECT rowid FROM audit_events WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
        this.db.prepare('DELETE FROM group_membership_events WHERE rowid IN (SELECT rowid FROM group_membership_events WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
         this.db.prepare('DELETE FROM ledger_period_balances WHERE rowid IN (SELECT rowid FROM ledger_period_balances WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
         this.db.prepare('DELETE FROM ledger_period_totals WHERE rowid IN (SELECT rowid FROM ledger_period_totals WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
         this.db.prepare('DELETE FROM ledger_period_build_gc WHERE rowid IN (SELECT rowid FROM ledger_period_build_gc WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
         this.db.prepare('DELETE FROM ledger_period_verify_balances WHERE rowid IN (SELECT rowid FROM ledger_period_verify_balances WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
        this.db.prepare('DELETE FROM ledger_period_verify_totals WHERE rowid IN (SELECT rowid FROM ledger_period_verify_totals WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
        this.db.prepare('DELETE FROM ledger_checkpoint_balances WHERE rowid IN (SELECT rowid FROM ledger_checkpoint_balances WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
        this.db.prepare('DELETE FROM ledger_checkpoint_totals WHERE rowid IN (SELECT rowid FROM ledger_checkpoint_totals WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
        this.db.prepare('DELETE FROM ledger_period_state WHERE rowid IN (SELECT rowid FROM ledger_period_state WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
        this.db.prepare('DELETE FROM ledger_summary_state WHERE rowid IN (SELECT rowid FROM ledger_summary_state WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
        this.db.prepare('DELETE FROM group_balance_projection WHERE rowid IN (SELECT rowid FROM group_balance_projection WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
        this.db.prepare('DELETE FROM ledger_totals WHERE rowid IN (SELECT rowid FROM ledger_totals WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
         this.db.prepare('DELETE FROM projection_state WHERE rowid IN (SELECT rowid FROM projection_state WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
          this.db.prepare('DELETE FROM group_invitations WHERE rowid IN (SELECT rowid FROM group_invitations WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
         this.db.prepare('DELETE FROM group_split_defaults WHERE rowid IN (SELECT rowid FROM group_split_defaults WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
         this.db.prepare('DELETE FROM idempotency_keys WHERE rowid IN (SELECT rowid FROM idempotency_keys WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
        this.db.prepare('DELETE FROM group_members WHERE rowid IN (SELECT rowid FROM group_members WHERE group_id=? LIMIT ?)').bind(groupId, maxTransactions),
        // The parent delete repeats the dependent checks in the same D1
        // batch. It therefore cannot race a later metadata insert and never
        // removes a group whose dependent table still contains a row.
        this.db.prepare(`DELETE FROM groups WHERE id=? AND deleted_at IS NOT NULL AND deleted_at<?
          AND NOT EXISTS (SELECT 1 FROM expenses child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM settlements child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM scheduled_expenses child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM group_members child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM group_invitations child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM audit_events child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM group_membership_events child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM ledger_period_balances child WHERE child.group_id=groups.id)
           AND NOT EXISTS (SELECT 1 FROM ledger_period_totals child WHERE child.group_id=groups.id)
           AND NOT EXISTS (SELECT 1 FROM ledger_period_build_gc child WHERE child.group_id=groups.id)
           AND NOT EXISTS (SELECT 1 FROM ledger_period_verify_balances child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM ledger_period_verify_totals child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM ledger_checkpoint_balances child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM ledger_checkpoint_totals child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM ledger_period_state child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM ledger_summary_state child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM group_balance_projection child WHERE child.group_id=groups.id)
          AND NOT EXISTS (SELECT 1 FROM ledger_totals child WHERE child.group_id=groups.id)
           AND NOT EXISTS (SELECT 1 FROM projection_state child WHERE child.group_id=groups.id)
           AND NOT EXISTS (SELECT 1 FROM group_split_defaults child WHERE child.group_id=groups.id)
           AND NOT EXISTS (SELECT 1 FROM idempotency_keys child WHERE child.group_id=groups.id)`).bind(groupId, cutoff),
         this.db.prepare('UPDATE group_purge_cursor SET deleted_at=?,group_id=?,updated_at=? WHERE id=1').bind(text(row.deleted_at), groupId, now()),
      ]);
      auditEventsPurged += Number((metadataResult[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
       if (Number((metadataResult[17] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0)) groupsPurged += 1;
      else {
        incomplete = true;
        await this.db.prepare('UPDATE groups SET updated_at=? WHERE id=? AND deleted_at IS NOT NULL AND deleted_at<?').bind(now(), groupId, cutoff).run();
      }
    }
    return { cutoff, transactionsScanned, transactionsPurged, groupsScanned: groups.length, groupsPurged, auditEventsPurged, capped: incomplete || groups.length >= maxGroups || !withinDeadline(options.deadlineMs) };
  }
  async globalActivity(userId: string, groupId: string | undefined, options: { limit?: number; cursor?: string }) {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100), cursor = decodeLedgerCursor(options.cursor);
    const boundary = cursor ? ' AND (activity.created_at<? OR (activity.created_at=? AND activity.id<?))' : '';
    const binds: unknown[] = groupId ? [userId, groupId] : [userId];
    if (cursor) binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
    binds.push(limit + 1);
    const rows = (await this.db.prepare(`
      SELECT activity.*,g.name AS group_name FROM (
        SELECT 'expense' AS type,e.id,e.id AS entity_id,1 AS entity_active,e.group_id,e.description AS label,e.amount_minor,e.currency,e.expense_date AS transaction_date,NULL AS from_name,NULL AS to_name,e.created_at
        FROM expenses e WHERE e.deleted_at IS NULL
        UNION ALL
        SELECT 'settlement',s.id,s.id,0,s.group_id,s.note,s.amount_minor,s.currency,s.settlement_date,p_from.name,p_to.name,s.created_at
        FROM settlements s LEFT JOIN people p_from ON p_from.id=s.from_person_id LEFT JOIN people p_to ON p_to.id=s.to_person_id WHERE s.deleted_at IS NULL
      ) activity JOIN groups g ON g.id=activity.group_id JOIN group_members gm ON gm.group_id=g.id
       WHERE gm.user_id=? AND gm.deleted_at IS NULL AND g.deleted_at IS NULL${groupId ? ' AND activity.group_id=?' : ''}${boundary}
       ORDER BY activity.created_at DESC,activity.id DESC LIMIT ?
    `).bind(...binds).all<Row>()).results;
    const mapped = rows.map((row) => ({ type: text(row.type) as Activity['type'], id: text(row.id), entityId: text(row.entity_id), entityActive: row.entity_active === true || number(row.entity_active) === 1,
      groupId: text(row.group_id), groupName: text(row.group_name), amountMinor: row.amount_minor == null ? null : minor(row.amount_minor), currency: row.currency == null ? null : currency(row.currency), transactionDate: text(row.transaction_date), label: row.label == null ? null : text(row.label),
       ...(text(row.type).startsWith('settlement') ? { fromName: row.from_name == null ? null : text(row.from_name), toName: row.to_name == null ? null : text(row.to_name) } : {}), createdAt: text(row.created_at) })) as Activity[];
    const hasMore = rows.length > limit, items = hasMore ? mapped.slice(0, limit) : mapped, last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? encodeLedgerCursor({ date: last.transactionDate, createdAt: last.createdAt, id: last.id }) : undefined };
  }
  async categories(userId: string) {
    // Category choices are account-private. Shared group membership is not a
    // reason to expose another member's learned or historical categories.
     // A category explicitly chosen by the user remains a preference after a
     // schedule is cancelled, so historical schedules contribute options too.
    const rows = (await this.db.prepare(`SELECT DISTINCT category FROM (
      SELECT cp.category FROM category_preferences cp WHERE cp.user_id=?
      UNION ALL
      SELECT e.category FROM expenses e
        WHERE e.created_by=? AND e.deleted_at IS NULL
          AND e.category IS NOT NULL AND trim(e.category)<>''
      UNION ALL
      SELECT se.category FROM scheduled_expenses se
        WHERE se.created_by=?
          AND se.category IS NOT NULL AND trim(se.category)<>''
    ) WHERE category IS NOT NULL AND trim(category)<>'' ORDER BY lower(category),category`).bind(userId, userId, userId).all<Row>()).results;
    return rows.map((row) => text(row.category));
  }
  async groupExportPage(groupId: string, options: { limit?: number; expenseCursor?: string | null; settlementCursor?: string | null } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const [g, members, splitDefault, expenses, settlements] = await Promise.all([
      this.db.prepare('SELECT * FROM groups WHERE id=? AND deleted_at IS NULL').bind(groupId).first<Row>().then(mapGroup),
      this.members(groupId),
      this.getGroupSplitDefault(groupId),
      options.expenseCursor === null ? Promise.resolve({ items: [], nextCursor: undefined }) : this.expensePage(groupId, { limit, cursor: options.expenseCursor }),
      options.settlementCursor === null ? Promise.resolve({ items: [], nextCursor: undefined }) : this.settlementPage(groupId, { limit, cursor: options.settlementCursor }),
    ]);
    return { version: 1, exportedAt: now(), group: g, splitDefault, members, expenses: expenses.items, settlements: settlements.items, nextCursor: expenses.nextCursor || settlements.nextCursor ? { expenses: expenses.nextCursor ?? null, settlements: settlements.nextCursor ?? null } : undefined };
  }
  async exportPage(userId: string, options: { groupCursor?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 1, 1), 2);
    let cursor: ExportCursor | undefined;
    if (options.groupCursor) {
      cursor = decodeExportCursor(options.groupCursor);
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
    let groupId = cursor ? await authorizedCursorGroup(cursor.groupId) : await nextGroup();
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
}
