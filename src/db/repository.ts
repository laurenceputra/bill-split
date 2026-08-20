import type { ExpenseInput, SettlementInput } from '../shared/schemas';
import type { D1Database } from '@cloudflare/workers-types';
import type { Activity, Expense, Group, GroupBalanceSummary, GroupMember, Settlement } from '../shared/types';
import { checkedMinor } from '../shared/money';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
type Row = Record<string, unknown>;

export class RepositoryError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'CONFLICT' | 'DATABASE_ERROR' | 'BALANCE_OVERFLOW' | 'SELF_FRIEND', message: string) { super(message); }
}
const text = (value: unknown) => String(value ?? '');
const number = (value: unknown) => Number(value ?? 0);
const minor = (value: unknown) => checkedMinor(value);
const currency = (value: unknown) => text(value) as Expense['currency'];
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, nested) => nested && typeof nested === 'object' && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : nested);

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
    SELECT e.group_id,e.currency,p.person_id,p.amount_minor AS net_minor
    FROM expenses e JOIN scoped_groups scope ON scope.group_id=e.group_id JOIN payers p ON p.expense_id=e.id
    WHERE e.deleted_at IS NULL
    UNION ALL
    SELECT e.group_id,e.currency,s.person_id,-s.amount_minor AS net_minor
    FROM expenses e JOIN scoped_groups scope ON scope.group_id=e.group_id JOIN splits s ON s.expense_id=e.id
    WHERE e.deleted_at IS NULL
    UNION ALL
    SELECT s.group_id,s.currency,s.from_person_id AS person_id,s.amount_minor AS net_minor
    FROM settlements s JOIN scoped_groups scope ON scope.group_id=s.group_id
    WHERE s.deleted_at IS NULL
    UNION ALL
    SELECT s.group_id,s.currency,s.to_person_id AS person_id,-s.amount_minor AS net_minor
    FROM settlements s JOIN scoped_groups scope ON scope.group_id=s.group_id
    WHERE s.deleted_at IS NULL
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

export class Repository {
  constructor(private readonly db: D1Database) {}

  async user(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    const t = now();
    await this.db.prepare('INSERT OR IGNORE INTO users(id,email,created_at,updated_at) VALUES(?,?,?,?)').bind(uid(), email, t, t).run();
    const user = await this.db.prepare('SELECT * FROM users WHERE email=?').bind(email).first<Row>();
    if (!user) throw new RepositoryError('DATABASE_ERROR', 'Unable to create user');
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
    await this.db.prepare('UPDATE group_members SET user_id=? WHERE person_id=? AND user_id IS NULL').bind(user.id, person.id).run();
    return { user, person };
  }
  async me(email: string) { return this.user(email); }

  async groups(userId: string): Promise<Group[]> {
    const rows = (await this.db.prepare(`${groupSelect()} WHERE g.deleted_at IS NULL ORDER BY g.created_at DESC`).bind(userId).all<Row>()).results;
    return rows.map((row) => mapGroup(row)!).filter(Boolean);
  }
  async group(groupId: string, userId: string): Promise<Group | null> {
    return mapGroup(await this.db.prepare(`${groupSelect(true)} WHERE g.id=? AND g.deleted_at IS NULL`).bind(userId, groupId, groupId).first<Row>());
  }
  async membership(groupId: string, userId: string): Promise<'owner' | 'member' | null> {
    const row = await this.db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=? AND deleted_at IS NULL').bind(groupId, userId).first<Row>();
    return row ? (text(row.role) === 'owner' ? 'owner' : 'member') : null;
  }
  async members(groupId: string): Promise<GroupMember[]> {
    const rows = (await this.db.prepare('SELECT p.id AS person_id,p.name,p.email,gm.joined_at,gm.role FROM people p JOIN group_members gm ON gm.person_id=p.id WHERE gm.group_id=? AND gm.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY p.name').bind(groupId).all<Row>()).results;
    return rows.map((row) => ({ personId: text(row.person_id), name: text(row.name), email: row.email == null ? null : text(row.email), joinedAt: text(row.joined_at), role: text(row.role) === 'owner' ? 'owner' : 'member' }));
  }
  async createGroup(userId: string, personId: string, input: { name: string; currency: string }) {
    const id = uid(), t = now();
    await this.db.batch([
      this.db.prepare('INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id, input.name, input.currency, t, t),
      this.db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES(?,?,?,?, 'owner')").bind(id, personId, userId, t),
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
    await this.db.prepare('UPDATE groups SET name=?,currency=?,updated_at=? WHERE id=? AND deleted_at IS NULL').bind(input.name, input.currency, now(), id).run();
    return this.group(id, userId);
  }
  async deleteGroup(id: string) { await this.db.prepare('UPDATE groups SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL').bind(now(), now(), id).run(); }
  async addPerson(groupId: string, person: { name: string; email?: string | null }, userId?: string, creatorPersonId?: string) {
    const id = uid(), t = now(), email = person.email?.trim().toLowerCase() ?? null;
    if (email) {
      const linkedUser = userId ? await this.db.prepare('SELECT email FROM users WHERE id=?').bind(userId).first<Row>() : null;
      const creator = creatorPersonId ? await this.db.prepare('SELECT * FROM people WHERE id=? AND deleted_at IS NULL').bind(creatorPersonId).first<Row>() : null;
      if (text(linkedUser?.email).toLowerCase() === email || (creator && text(creator.email).toLowerCase() === email)) throw new RepositoryError('SELF_FRIEND', 'You cannot add your own linked person as a friend');
      const existing = await this.db.prepare('SELECT * FROM people WHERE lower(email)=? AND deleted_at IS NULL').bind(email).first<Row>();
      if (existing) {
        if (text(existing.id) === creatorPersonId || text(existing.user_id) === userId) throw new RepositoryError('SELF_FRIEND', 'You cannot add your own linked person as a friend');
        await this.db.prepare("INSERT OR IGNORE INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES(?,?,?,?, 'member')").bind(groupId, existing.id, existing.user_id ?? null, t).run();
        return { id: text(existing.id), name: text(existing.name), email, createdAt: text(existing.created_at) };
      }
    }
    await this.db.batch([
      this.db.prepare('INSERT INTO people(id,name,email,created_at) VALUES(?,?,?,?)').bind(id, person.name, email, t),
      this.db.prepare("INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES(?,?,?, 'member')").bind(groupId, id, t),
    ]);
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
  async expenses(groupId: string, opts: { q?: string; person?: string; category?: string; from?: string; to?: string; currency?: string; limit: number; offset: number }) {
    let sql = 'SELECT * FROM expenses WHERE group_id=? AND deleted_at IS NULL'; const args: unknown[] = [groupId];
    if (opts.q) { sql += ' AND (description LIKE ? OR notes LIKE ?)'; args.push(`%${opts.q}%`, `%${opts.q}%`); }
    if (opts.category) { sql += ' AND category=?'; args.push(opts.category); }
    if (opts.currency) { sql += ' AND currency=?'; args.push(opts.currency); }
    if (opts.from) { sql += ' AND expense_date>=?'; args.push(opts.from); }
    if (opts.to) { sql += ' AND expense_date<=?'; args.push(opts.to); }
    if (opts.person) { sql += ' AND id IN (SELECT expense_id FROM splits WHERE person_id=? UNION SELECT expense_id FROM payers WHERE person_id=?)'; args.push(opts.person, opts.person); }
    sql += ' ORDER BY expense_date DESC,created_at DESC LIMIT ? OFFSET ?'; args.push(opts.limit, opts.offset);
     return this.hydrateExpenses((await this.db.prepare(sql).bind(...args).all<Row>()).results);
  }
  async allExpenses(groupId: string) {
    const result: Expense[] = []; const pageSize = 500; let offset = 0;
    while (true) { const page = await this.expenses(groupId, { limit: pageSize, offset }); result.push(...page); if (page.length < pageSize) return result; offset += pageSize; }
  }
  async expense(id: string) { const row = await this.rawExpense(id); return row && !row.deleted_at ? this.hydrateExpense(row) : null; }

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
  private static isRevisionUnique(error: unknown) {
    return Repository.isUnique(error) && error instanceof Error && /revisions\.(entity_type|entity_id|revision)/i.test(error.message);
  }
  private static isBalanceOverflow(error: unknown) { return error instanceof Error && /BALANCE_OVERFLOW|ledger total/i.test(error.message); }
  private static balanceOverflow() { return new RepositoryError('BALANCE_OVERFLOW', 'The group ledger total exceeds the safe integer range'); }
  private async conditionalBatch(statements: ReturnType<D1Database['prepare']>[]) {
    try {
      await this.db.batch(statements);
    } catch (error) {
      if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow();
      // A concurrent mutation can collide on the revision number. Only that
      // known unique constraint is a stale-write signal; child/table errors
      // must retain their original meaning and still roll the batch back.
      if (Repository.isRevisionUnique(error)) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
      throw error;
    }
  }

  async createExpense(groupId: string, userId: string, input: ExpenseInput) {
    const scopedOperation = input.client_operation_id ? `${groupId}:${input.client_operation_id}` : undefined;
    const hash = stableJson(input);
    const operation = input.client_operation_id ? await this.operation('expense.create', userId, groupId, input.client_operation_id, hash) : { id: uid(), claim: true };
    if (!operation.claim) { const existing = await this.expense(operation.id); if (existing && existing.groupId === groupId) return existing; throw new RepositoryError('DATABASE_ERROR', 'Idempotency result is unavailable'); }
    const id = operation.id, t = now();
    const statements = [
      ...(input.client_operation_id ? [this.db.prepare('INSERT INTO idempotency_keys(kind,user_id,group_id,operation_id,request_hash,entity_id,created_at) VALUES(?,?,?,?,?,?,?)').bind('expense.create', userId, groupId, input.client_operation_id, hash, id, t)] : []),
      this.db.prepare('INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,category,notes,created_by,created_at,updated_at,client_operation_id,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)').bind(id, groupId, input.description, input.amount_minor, input.currency, input.date, input.category ?? null, input.notes ?? null, userId, t, t, scopedOperation ?? null),
      ...input.payers.map((p) => this.db.prepare('INSERT INTO payers(expense_id,person_id,amount_minor) VALUES(?,?,?)').bind(id, p.person_id, p.amount_minor)),
      ...input.splits.map((s) => this.db.prepare('INSERT INTO splits(expense_id,person_id,amount_minor,metadata_json) VALUES(?,?,?,?)').bind(id, s.person_id, s.amount_minor, s.metadata ? JSON.stringify(s.metadata) : null)),
    ];
    try { await this.db.batch(statements); } catch (error) {
      if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow();
      if (!input.client_operation_id || !Repository.isUnique(error)) throw error;
      const existing = await this.existingClaim('expense.create', userId, groupId, input.client_operation_id);
      if (!existing) throw error;
      if (text(existing.request_hash) !== hash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
      const found = await this.expense(text(existing.entity_id)); if (found && found.groupId === groupId) return found; throw error;
    }
    return this.expense(id);
  }

  async updateExpense(id: string, userId: string, input: ExpenseInput) {
    if (!input.version) throw new RepositoryError('CONFLICT', 'A record version is required');
    const old = await this.expense(id); if (!old) throw new RepositoryError('CONFLICT', 'The record was deleted by another request');
    if (old.version !== input.version) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
    const t = now(), next = input.version + 1, revisionId = uid();
    const statements = [
      this.db.prepare('UPDATE expenses SET description=?,amount_minor=?,currency=?,expense_date=?,category=?,notes=?,updated_at=?,version=? WHERE id=? AND version=? AND deleted_at IS NULL').bind(input.description, input.amount_minor, input.currency, input.date, input.category ?? null, input.notes ?? null, t, next, id, input.version),
      this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=? AND deleted_at IS NULL)').bind(revisionId, 'expense', id, input.version, JSON.stringify(old), userId, t, id, next),
      this.db.prepare('DELETE FROM payers WHERE expense_id=? AND EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=?)').bind(id, id, next),
      this.db.prepare('DELETE FROM splits WHERE expense_id=? AND EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=?)').bind(id, id, next),
      ...input.payers.map((p) => this.db.prepare('INSERT INTO payers(expense_id,person_id,amount_minor) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=?)').bind(id, p.person_id, p.amount_minor, id, next)),
      ...input.splits.map((s) => this.db.prepare('INSERT INTO splits(expense_id,person_id,amount_minor,metadata_json) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=?)').bind(id, s.person_id, s.amount_minor, s.metadata ? JSON.stringify(s.metadata) : null, id, next)),
    ];
     await this.conditionalBatch(statements);
    const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.rawExpense(id); if (!revision || !current || number(current.version) !== next) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
    return this.hydrateExpense(current);
  }
  async deleteExpense(id: string, userId: string, version: number) {
    const old = await this.expense(id); if (!old) return false; if (old.version !== version) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); const t = now(), next = version + 1, revisionId = uid();
     await this.conditionalBatch([
      this.db.prepare('UPDATE expenses SET deleted_at=?,updated_at=?,version=? WHERE id=? AND version=? AND deleted_at IS NULL').bind(t, t, next, id, version),
      this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM expenses WHERE id=? AND version=? AND deleted_at IS NOT NULL)').bind(revisionId, 'expense', id, version, JSON.stringify(old), userId, t, id, next),
    ]);
    const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.rawExpense(id); if (!revision || !current || number(current.version) !== next || !current.deleted_at) throw new RepositoryError('CONFLICT', 'The record was changed by another request');
    return true;
  }

  private mapSettlement(row: Row): Settlement { return { id: text(row.id), groupId: text(row.group_id), fromPersonId: text(row.from_person_id), toPersonId: text(row.to_person_id), amountMinor: minor(row.amount_minor), currency: currency(row.currency), date: text(row.settlement_date), note: row.note == null ? null : text(row.note), createdAt: text(row.created_at), updatedAt: text(row.updated_at), deletedAt: row.deleted_at == null ? null : text(row.deleted_at), version: number(row.version) || 1 }; }
  async settlements(groupId: string) { return (await this.db.prepare('SELECT * FROM settlements WHERE group_id=? AND deleted_at IS NULL ORDER BY settlement_date DESC,created_at DESC').bind(groupId).all<Row>()).results.map((row) => this.mapSettlement(row)); }
  async settlement(id: string) { const row = await this.db.prepare('SELECT * FROM settlements WHERE id=? AND deleted_at IS NULL').bind(id).first<Row>(); return row ? this.mapSettlement(row) : null; }
  async createSettlement(groupId: string, userId: string, input: SettlementInput) {
    const hash = stableJson(input), operation = input.client_operation_id ? await this.operation('settlement.create', userId, groupId, input.client_operation_id, hash) : { id: uid(), claim: true };
    if (!operation.claim) { const existing = await this.settlement(operation.id); if (existing && existing.groupId === groupId) return existing; throw new RepositoryError('DATABASE_ERROR', 'Idempotency result is unavailable'); }
    const id = operation.id, t = now();
    const statements = [
      ...(input.client_operation_id ? [this.db.prepare('INSERT INTO idempotency_keys(kind,user_id,group_id,operation_id,request_hash,entity_id,created_at) VALUES(?,?,?,?,?,?,?)').bind('settlement.create', userId, groupId, input.client_operation_id, hash, id, t)] : []),
      this.db.prepare('INSERT INTO settlements(id,group_id,from_person_id,to_person_id,amount_minor,currency,settlement_date,note,created_by,created_at,updated_at,client_operation_id,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)').bind(id, groupId, input.from_person_id, input.to_person_id, input.amount_minor, input.currency, input.date, input.note ?? null, userId, t, t, input.client_operation_id ? `${groupId}:${input.client_operation_id}` : null),
    ];
    try { await this.db.batch(statements); } catch (error) {
      if (Repository.isBalanceOverflow(error)) throw Repository.balanceOverflow();
      if (!input.client_operation_id || !Repository.isUnique(error)) throw error;
      const existing = await this.existingClaim('settlement.create', userId, groupId, input.client_operation_id);
      if (!existing) throw error; if (text(existing.request_hash) !== hash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
      const found = await this.settlement(text(existing.entity_id)); if (found && found.groupId === groupId) return found; throw error;
    }
    return this.settlement(id);
  }
  async updateSettlement(id: string, userId: string, input: SettlementInput) {
    if (!input.version) throw new RepositoryError('CONFLICT', 'A record version is required'); const old = await this.settlement(id); if (!old) throw new RepositoryError('CONFLICT', 'The record was deleted by another request'); if (old.version !== input.version) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); const t = now(), next = input.version + 1, revisionId = uid();
     await this.conditionalBatch([
      this.db.prepare('UPDATE settlements SET from_person_id=?,to_person_id=?,amount_minor=?,currency=?,settlement_date=?,note=?,updated_at=?,version=? WHERE id=? AND version=? AND deleted_at IS NULL').bind(input.from_person_id, input.to_person_id, input.amount_minor, input.currency, input.date, input.note ?? null, t, next, id, input.version),
      this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM settlements WHERE id=? AND version=? AND deleted_at IS NULL)').bind(revisionId, 'settlement', id, input.version, JSON.stringify(old), userId, t, id, next),
    ]);
    const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.db.prepare('SELECT * FROM settlements WHERE id=?').bind(id).first<Row>(); if (!revision || !current || number(current.version) !== next) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); return this.mapSettlement(current);
  }
  async deleteSettlement(id: string, userId: string, version: number) {
    const old = await this.settlement(id); if (!old) return false; if (old.version !== version) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); const t = now(), next = version + 1, revisionId = uid();
     await this.conditionalBatch([
      this.db.prepare('UPDATE settlements SET deleted_at=?,updated_at=?,version=? WHERE id=? AND version=? AND deleted_at IS NULL').bind(t, t, next, id, version),
      this.db.prepare('INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM settlements WHERE id=? AND version=? AND deleted_at IS NOT NULL)').bind(revisionId, 'settlement', id, version, JSON.stringify(old), userId, t, id, next),
    ]);
    const revision = await this.db.prepare('SELECT id FROM revisions WHERE id=?').bind(revisionId).first<Row>();
    const current = await this.db.prepare('SELECT * FROM settlements WHERE id=?').bind(id).first<Row>(); if (!revision || !current || number(current.version) !== next || !current.deleted_at) throw new RepositoryError('CONFLICT', 'The record was changed by another request'); return true;
  }

  async revisions(type: string, id: string) {
    const rows = (await this.db.prepare('SELECT id,entity_type,entity_id,revision,snapshot_json,created_by,created_at FROM revisions WHERE entity_type=? AND entity_id=? ORDER BY revision DESC').bind(type, id).all<Row>()).results;
    return rows.map((row) => ({ id: text(row.id), entityType: text(row.entity_type), entityId: text(row.entity_id), revision: number(row.revision), snapshot: JSON.parse(text(row.snapshot_json)), createdBy: text(row.created_by), createdAt: text(row.created_at) }));
  }
  async activity(groupId: string) {
    const rows = (await this.db.prepare(`
      SELECT 'expense' AS type,e.id,e.id AS entity_id,e.description AS label,e.amount_minor,e.currency,e.expense_date AS transaction_date,NULL AS from_name,NULL AS to_name,e.created_at
      FROM expenses e WHERE e.group_id=? AND e.deleted_at IS NULL
      UNION ALL
      SELECT 'settlement' AS type,s.id,s.id AS entity_id,s.note AS label,s.amount_minor,s.currency,s.settlement_date AS transaction_date,p_from.name AS from_name,p_to.name AS to_name,s.created_at
      FROM settlements s LEFT JOIN people p_from ON p_from.id=s.from_person_id LEFT JOIN people p_to ON p_to.id=s.to_person_id
      WHERE s.group_id=? AND s.deleted_at IS NULL
      UNION ALL
       SELECT CASE WHEN (r.entity_type='expense' AND e.deleted_at IS NOT NULL AND e.version = r.revision + 1) OR (r.entity_type='settlement' AND s.deleted_at IS NOT NULL AND s.version = r.revision + 1)
         THEN r.entity_type || '_deleted' ELSE r.entity_type || '_revision' END AS type,
        r.id,r.entity_id,
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
      WHERE (e.group_id=? OR s.group_id=?)
      ORDER BY created_at DESC LIMIT 100
    `).bind(groupId, groupId, groupId, groupId).all<Row>()).results;
    return rows.map((row) => ({
      type: text(row.type) as Activity['type'], id: text(row.id), entityId: text(row.entity_id),
      amountMinor: row.amount_minor == null ? null : minor(row.amount_minor), currency: row.currency == null ? null : currency(row.currency),
      transactionDate: text(row.transaction_date), label: row.label == null ? null : text(row.label),
      ...(text(row.type).startsWith('settlement') ? { fromName: row.from_name == null ? null : text(row.from_name), toName: row.to_name == null ? null : text(row.to_name) } : {}),
      createdAt: text(row.created_at),
    })) as Activity[];
  }
  async allExport(userId: string) { const groups = await this.groups(userId); const out = []; for (const group of groups) { const [members, expenses, settlements] = await Promise.all([this.members(group.id), this.allExpenses(group.id), this.settlements(group.id)]); out.push({ ...group, members, expenses, settlements }); } return { version: 1, exportedAt: now(), groups: out }; }
  async groupExport(groupId: string) { const g = mapGroup(await this.db.prepare('SELECT * FROM groups WHERE id=? AND deleted_at IS NULL').bind(groupId).first<Row>()); const [members, expenses, settlements] = await Promise.all([this.members(groupId), this.allExpenses(groupId), this.settlements(groupId)]); return { version: 1, exportedAt: now(), group: g, members, expenses, settlements }; }
}
