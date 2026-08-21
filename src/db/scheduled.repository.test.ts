import { describe, expect, it } from 'vitest';
import { Repository } from './repository';
import type { ScheduledExpenseInput } from '../shared/schemas';
import { addCalendarDays } from '../domain/recurrence';

class ScheduledDb {
  batches: string[][] = [];
  prepare(sql: string) { return new ScheduledStatement(this, sql); }
  async batch(statements: ScheduledStatement[]) { this.batches.push(statements.map((statement) => statement.sql)); return []; }
}
class ScheduledStatement {
  args: unknown[] = [];
  constructor(private readonly db: ScheduledDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('FROM idempotency_keys')) return null;
    if (this.sql.includes('FROM scheduled_expenses')) return {
      id: 'scheduled-1', group_id: 'group-1', description: 'Rent', amount_minor: 1000, currency: 'USD', start_date: '2026-01-31', end_date: null,
      frequency: 'monthly', interval_count: 1, weekdays_json: '[]', timezone: 'America/New_York', status: 'active', next_occurrence_date: '2026-01-31',
       created_by: 'user-1', created_at: '', updated_at: '', version: 1, client_operation_id: null, category: 'Custom rent',
    } as T;
    return null;
  }
  async all<T>() { return { results: [] as T[] }; }
  async run() { return { meta: { changes: 1 } }; }
}

const scheduledRow = {
  id: 'scheduled-1', group_id: 'group-1', description: 'Rent', amount_minor: 1000, currency: 'USD', start_date: '2026-01-01', end_date: null,
  frequency: 'monthly', interval_count: 1, weekdays_json: '[]', timezone: 'UTC', status: 'active', blocked_reason: null, next_occurrence_date: '2026-01-01',
  created_by: 'user-1', created_at: '', updated_at: '', version: 1, client_operation_id: 'group-1:rent-template',
};

class ScheduledBulkDb {
  prepares: string[] = [];
  binds: unknown[][] = [];
  prepare(sql: string) { this.prepares.push(sql); return new ScheduledBulkStatement(this, sql); }
}
class ScheduledBulkStatement {
  args: unknown[] = [];
  constructor(private readonly db: ScheduledBulkDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; this.db.binds.push(args); return this; }
  async all<T>() {
    if (this.sql.includes('FROM scheduled_expenses')) return { results: [scheduledRow, { ...scheduledRow, id: 'scheduled-2', client_operation_id: null }] as T[] };
    if (this.sql.includes('FROM scheduled_payers')) return { results: [{ scheduled_expense_id: 'scheduled-1', person_id: 'person-1', amount_minor: 1000 }, { scheduled_expense_id: 'scheduled-2', person_id: 'person-2', amount_minor: 1000 }] as T[] };
    return { results: [{ scheduled_expense_id: 'scheduled-1', person_id: 'person-1', amount_minor: 1000, metadata_json: null }, { scheduled_expense_id: 'scheduled-2', person_id: 'person-2', amount_minor: 1000, metadata_json: null }] as T[] };
  }
}

class ResumeDb {
  row: Record<string, unknown>;
  readonly generated = new Set<string>();
  constructor(row: Record<string, unknown> = { ...scheduledRow, status: 'paused' }, generated: string[] = []) { this.row = row; for (const date of generated) this.generated.add(date); }
  prepare(sql: string) { return new ResumeStatement(this, sql); }
  async batch(statements: ResumeStatement[]) {
    const parent = statements[0];
    if (parent?.sql.includes('UPDATE scheduled_expenses SET description=')) {
      this.row = { ...this.row, status: parent.args[9], next_occurrence_date: parent.args[10], version: parent.args[13], generation_claim_id: null };
    }
    return statements.map((_, index) => ({ meta: { changes: index === 0 ? 1 : 0 } }));
  }
}
class ResumeStatement {
  args: unknown[] = [];
  constructor(private readonly db: ResumeDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('FROM scheduled_expenses')) return this.db.row as T;
    if (this.sql.includes('FROM scheduled_occurrences')) return this.db.generated.has(String(this.args[1])) ? { occurrence_date: this.args[1] } as T : null;
    return null;
  }
  async all<T>() {
    if (this.sql.includes('FROM scheduled_occurrences')) return { results: [...this.db.generated].map((occurrence_date) => ({ occurrence_date })) as T[] };
    return { results: [] as T[] };
  }
  async run() {
    if (this.sql.includes('SET status=?')) { this.db.row = { ...this.db.row, status: String(this.args[0]), next_occurrence_date: this.args[1] as string | null, version: Number(this.args[3]) }; }
    return { meta: { changes: 1 } };
  }
}

class GenerationDb {
  batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
  claimChanges = 1;
  overflowForFirst = false;
  permanentForFirst = false;
  uniqueForFirst = false;
  existingOccurrenceForFirst = false;
  private uniqueThrown = false;
  participantCount = 1;
  cursorId: string | null = null;
  preparedRows: Record<string, unknown>[];
  constructor(rows: Record<string, unknown>[] = [scheduledRow]) { this.preparedRows = rows; }
  prepare(sql: string) { return new GenerationStatement(this, sql); }
  async batch(statements: GenerationStatement[]) {
    this.batches.push(statements.map((statement) => ({ sql: statement.sql, args: statement.args })));
    if (this.overflowForFirst && statements.some((statement) => statement.sql.includes('INSERT INTO expenses')) && !this.batches.slice(0, -1).some((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO expenses')))) throw new Error('SQLITE_CONSTRAINT: BALANCE_OVERFLOW');
    if (this.permanentForFirst && statements.some((statement) => statement.sql.includes('INSERT INTO expenses')) && !this.batches.slice(0, -1).some((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO expenses')))) throw new Error('SQLITE_ERROR: too many SQL variables');
    if (this.uniqueForFirst && statements.some((statement) => statement.sql.includes('INSERT INTO expenses')) && !this.uniqueThrown) { this.uniqueThrown = true; throw new Error('UNIQUE constraint failed: expenses.created_by, expenses.client_operation_id'); }
    if (statements[0]?.sql.includes('UPDATE scheduled_expenses SET generation_claim_id')) {
      const existing = this.existingOccurrenceForFirst && !this.batches.slice(0, -1).some((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO expenses')));
      return statements.map((_, index) => ({ meta: { changes: index === 0 ? this.claimChanges : existing ? index === statements.length - 2 ? 1 : 0 : index === statements.length - 3 || index === statements.length - 2 ? 1 : 0 } }));
    }
    return [];
  }
}
class GenerationStatement {
  args: unknown[] = [];
  constructor(private readonly db: GenerationDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('FROM scheduled_generation_cursor')) return { cursor_id: this.db.cursorId } as T;
    return null as T | null;
  }
  async all<T>() {
    if (this.sql.includes('FROM scheduled_expenses')) {
      const cursor = this.args[2] == null ? null : String(this.args[2]);
      const sorted = [...this.db.preparedRows].sort((left, right) => String(left.id).localeCompare(String(right.id)));
      const ordered = cursor ? [...sorted.filter((row) => String(row.id) > cursor), ...sorted.filter((row) => String(row.id) <= cursor)] : sorted;
      return { results: ordered.slice(0, Number(this.args[4] ?? ordered.length)) as T[] };
    }
    if (this.sql.includes('FROM scheduled_payers')) return { results: this.db.preparedRows.flatMap((row) => Array.from({ length: this.db.participantCount === 1 ? 1 : Math.ceil(this.db.participantCount / 2) }, (_, index) => ({ scheduled_expense_id: row.id, person_id: `person-${this.db.participantCount === 1 ? 1 : index}`, amount_minor: 1000 }))) as T[] };
    if (this.sql.includes('FROM scheduled_splits')) return { results: this.db.preparedRows.flatMap((row) => Array.from({ length: this.db.participantCount === 1 ? 1 : Math.floor(this.db.participantCount / 2) }, (_, index) => ({ scheduled_expense_id: row.id, person_id: `person-${this.db.participantCount === 1 ? 1 : Math.ceil(this.db.participantCount / 2) + index}`, amount_minor: 1000, metadata_json: null }))) as T[] };
    if (this.sql.includes('FROM group_members')) return { results: this.db.preparedRows.flatMap((row) => Array.from({ length: this.db.participantCount }, (_, index) => ({ group_id: row.group_id, person_id: `person-${this.db.participantCount === 1 ? 1 : index}` }))) as T[] };
    return { results: [] as T[] };
  }
  async run() {
    if (this.sql.includes('scheduled_generation_cursor')) {
      if ((this.args[2] == null ? null : String(this.args[2])) === this.db.cursorId) this.db.cursorId = String(this.args[0]);
    }
    return { meta: { changes: 1 } };
  }
}

class InterleavedScheduledDb {
  row: Record<string, unknown> = { ...scheduledRow };
  payers: Array<{ person_id: string; amount_minor: number }> = [{ person_id: 'person-old', amount_minor: 1000 }];
  splits: Array<{ person_id: string; amount_minor: number; metadata_json: unknown }> = [{ person_id: 'person-old', amount_minor: 1000, metadata_json: null }];
  reads = 0;
  private releaseReads!: () => void;
  private readonly readsReleased = new Promise<void>((resolve) => { this.releaseReads = resolve; });
  prepare(sql: string) { return new InterleavedScheduledStatement(this, sql); }
  async batch(statements: InterleavedScheduledStatement[]) {
    const parent = statements[0];
    const oldVersion = Number(parent.args[15]);
    const claimId = String(parent.args[11]);
    const won = Number(this.row.version) === oldVersion && this.row.generation_claim_id == null;
    if (won) {
      this.row = { ...this.row, description: parent.args[0], version: parent.args[13], generation_claim_id: claimId };
      this.payers = []; this.splits = [];
      for (const statement of statements.slice(3, -1)) {
        if (statement.sql.includes('scheduled_payers')) this.payers.push({ person_id: String(statement.args[1]), amount_minor: Number(statement.args[2]) });
        if (statement.sql.includes('scheduled_splits')) this.splits.push({ person_id: String(statement.args[1]), amount_minor: Number(statement.args[2]), metadata_json: statement.args[3] == null ? null : String(statement.args[3]) });
      }
      this.row = { ...this.row, generation_claim_id: null };
    }
    return statements.map((_, index) => ({ meta: { changes: won ? (index === 0 ? 1 : 0) : 0 } }));
  }
  async readScheduled<T>() {
    const snapshot = { ...this.row } as T;
    this.reads += 1;
    if (this.reads === 2) this.releaseReads();
    if (this.reads <= 2) await this.readsReleased;
    return snapshot;
  }
}
class InterleavedScheduledStatement {
  args: unknown[] = [];
  constructor(private readonly db: InterleavedScheduledDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() { return this.sql.includes('FROM scheduled_expenses') ? this.db.readScheduled<T>() : null; }
  async all<T>() {
    if (this.sql.includes('scheduled_payers')) return { results: this.db.payers as T[] };
    if (this.sql.includes('scheduled_splits')) return { results: this.db.splits as T[] };
    return { results: [] as T[] };
  }
}

class CronStatusInterleavedDb {
  row: Record<string, unknown> = { ...scheduledRow, status: 'active', end_date: '2026-01-01', generation_claim_id: null };
  private releaseStatus!: () => void;
  private readonly statusAllowed = new Promise<void>((resolve) => { this.releaseStatus = resolve; });
  private resolveStatusReady!: () => void;
  readonly statusReady = new Promise<void>((resolve) => { this.resolveStatusReady = resolve; });
  prepare(sql: string) { return new CronStatusInterleavedStatement(this, sql); }
  allowStatusUpdate() { this.releaseStatus(); }
  markStatusReady() { this.resolveStatusReady(); }
  waitForStatusUpdate() { return this.statusAllowed; }
  async batch(statements: CronStatusInterleavedStatement[]) {
    if (!statements[0]?.sql.includes('UPDATE scheduled_expenses SET generation_claim_id')) return [];
    const oldVersion = Number(statements[0].args[2]);
    const won = Number(this.row.version) === oldVersion && this.row.generation_claim_id == null;
    if (won) {
      const advanced = statements[statements.length - 2];
      this.row = {
        ...this.row,
        status: advanced.args[0] == null ? 'completed' : 'active',
        next_occurrence_date: advanced.args[1],
        generation_claim_id: null,
        version: oldVersion + 1,
      };
    }
    return statements.map((_, index) => ({ meta: { changes: won ? (index === 0 || index === statements.length - 3 || index === statements.length - 2 ? 1 : 0) : 0 } }));
  }
}
class CronStatusInterleavedStatement {
  args: unknown[] = [];
  constructor(private readonly db: CronStatusInterleavedDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('scheduled_generation_cursor')) return { cursor_id: null } as T;
    return this.sql.includes('FROM scheduled_expenses') ? this.db.row as T : null;
  }
  async all<T>() {
    if (this.sql.includes('FROM scheduled_expenses')) return { results: [this.db.row] as T[] };
    if (this.sql.includes('scheduled_payers')) return { results: [{ scheduled_expense_id: this.db.row.id, person_id: 'person-1', amount_minor: 1000 }] as T[] };
    if (this.sql.includes('scheduled_splits')) return { results: [{ scheduled_expense_id: this.db.row.id, person_id: 'person-1', amount_minor: 1000, metadata_json: null }] as T[] };
    if (this.sql.includes('FROM group_members')) return { results: [{ group_id: this.db.row.group_id, person_id: 'person-1' }] as T[] };
    return { results: [] as T[] };
  }
  async run() {
    if (this.sql.includes('SET status=?')) {
      this.db.markStatusReady();
      await this.db.waitForStatusUpdate();
      const expectedVersion = Number(this.args[5]);
      if (Number(this.db.row.version) !== expectedVersion || this.db.row.generation_claim_id != null) return { meta: { changes: 0 } };
      this.db.row = { ...this.db.row, status: this.args[0], next_occurrence_date: this.args[1], version: this.args[3] };
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }
}

const input: ScheduledExpenseInput = {
  description: 'Rent', amount_minor: 1000, currency: 'USD', category: 'Custom rent', start_date: '2026-01-31', end_date: null,
  frequency: 'monthly', interval: 1, weekdays: [], timezone: 'America/New_York',
  payers: [{ person_id: '00000000-0000-0000-0000-000000000001', amount_minor: 1000 }],
  splits: [{ person_id: '00000000-0000-0000-0000-000000000001', amount_minor: 1000 }], client_operation_id: 'rent-template',
};

describe('scheduled expense repository', () => {
  it('persists the timezone, recurrence cursor, children, and a retry claim', async () => {
    const db = new ScheduledDb();
    const result = await new Repository(db as never).createScheduledExpense('group-1', 'user-1', input);
     expect(result).toMatchObject({ id: 'scheduled-1', timezone: 'America/New_York', frequency: 'monthly', interval: 1, category: 'Custom rent' });
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO scheduled_expenses'),
      expect.stringContaining('INSERT INTO scheduled_payers'),
      expect.stringContaining('INSERT INTO scheduled_splits'),
      expect.stringContaining('INSERT INTO idempotency_keys'),
    ]));
  });

  it('bulk-hydrates a schedule page and strips the internal operation prefix', async () => {
    const db = new ScheduledBulkDb();
    const result = await new Repository(db as never).scheduledExpenses('group-1', { limit: 500, offset: 0 });
    expect(result).toHaveLength(2);
    expect(result[0].clientOperationId).toBe('rent-template');
    expect(db.prepares.filter((sql) => sql.includes('scheduled_payers') || sql.includes('scheduled_splits'))).toHaveLength(2);
    expect(db.prepares.find((sql) => sql.includes('scheduled_expenses'))).toContain('LIMIT ? OFFSET ?');
    expect(db.binds[0].slice(-2)).toEqual([100, 0]);
  });

  it('recalculates a resumed cursor from the schedule timezone and skips elapsed dates', async () => {
    const db = new ResumeDb();
    const result = await new Repository(db as never).resumeScheduledExpense('scheduled-1', 1, new Date('2026-01-06T08:30:00Z'));
    expect(result.nextOccurrenceDate).toBe('2026-02-01');
    expect(db.row.status).toBe('active');
  });

  it('does not resume on a same-day occurrence that was already generated', async () => {
    const db = new ResumeDb({ ...scheduledRow, status: 'paused', start_date: '2026-01-01', next_occurrence_date: '2026-01-01', frequency: 'daily', interval_count: 1 }, ['2026-01-01']);
    const result = await new Repository(db as never).resumeScheduledExpense('scheduled-1', 1, new Date('2026-01-01T12:00:00Z'));
    expect(result.nextOccurrenceDate).toBe('2026-01-02');
  });

  it('does not reset an edited schedule to a same-day occurrence that was already generated', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const db = new ResumeDb({ ...scheduledRow, start_date: today, next_occurrence_date: today, frequency: 'daily', interval_count: 1 }, [today]);
    const result = await new Repository(db as never).updateScheduledExpense('scheduled-1', 'user-1', {
      ...input, start_date: today, frequency: 'daily', interval: 1, weekdays: [], timezone: 'UTC', version: 1,
    });
    expect(result.nextOccurrenceDate).toBe(addCalendarDays(today, 1));
  });

  it('does not let the losing version update replace the winning children', async () => {
    const db = new InterleavedScheduledDb();
    const winner = { ...input, description: 'Winner', version: 1 };
    const loser = { ...input, description: 'Loser', version: 1, payers: [{ person_id: '00000000-0000-0000-0000-000000000002', amount_minor: 1000 }], splits: [{ person_id: '00000000-0000-0000-0000-000000000002', amount_minor: 1000 }] };
    const repository = new Repository(db as never);
    const results = await Promise.allSettled([repository.updateScheduledExpense('scheduled-1', 'user-1', winner), repository.updateScheduledExpense('scheduled-1', 'user-2', loser)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ code: 'CONFLICT' }) });
    expect(db.row.description).toBe('Winner');
    expect(db.payers).toEqual([{ person_id: winner.payers[0].person_id, amount_minor: 1000 }]);
    expect(db.splits).toEqual([{ person_id: winner.splits[0].person_id, amount_minor: 1000, metadata_json: null }]);
  });

  it('uses one atomic claimed batch whose writes are guarded by status, version, group, and members', async () => {
    const db = new GenerationDb();
    const result = await new Repository(db as never).generateDueScheduledExpenses('2026-01-02');
    expect(result.generated).toBe(1);
    const generation = db.batches.find((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO expenses')))!;
    expect(generation[0].sql).toContain('generation_claim_id');
    for (const statement of generation.filter((item) => /INSERT INTO (expenses|payers|splits|scheduled_occurrences)/.test(item.sql))) {
      expect(statement.sql).toMatch(/status='active'/);
      expect(statement.sql).toContain('schedule.version=?');
      expect(statement.sql).toContain('g.deleted_at IS NULL');
      expect(statement.sql).toContain('gm.deleted_at IS NULL');
    }
  });

  it('advances past an occurrence that already exists and continues with later schedules', async () => {
    const db = new GenerationDb([{ ...scheduledRow, id: 'scheduled-existing' }, { ...scheduledRow, id: 'scheduled-later' }]);
    db.existingOccurrenceForFirst = true;
    const result = await new Repository(db as never).generateDueScheduledExpenses('2026-01-02');
    expect(result).toMatchObject({ generated: 1, blocked: 0, processed: 2 });
  });

  it('does not generate when a concurrent status/version mutation wins the claim', async () => {
    const db = new GenerationDb(); db.claimChanges = 0;
    const result = await new Repository(db as never).generateDueScheduledExpenses('2026-01-02');
    expect(result.generated).toBe(0);
    expect(result.blocked).toBe(0);
  });

  it('blocks an overflow schedule but continues with later schedules', async () => {
    const db = new GenerationDb([{ ...scheduledRow, id: 'scheduled-overflow' }, { ...scheduledRow, id: 'scheduled-later' }]);
    db.overflowForFirst = true;
    const result = await new Repository(db as never).generateDueScheduledExpenses('2026-01-02');
    expect(result).toMatchObject({ generated: 1, blocked: 1 });
    expect(db.batches.some((batch) => batch.some((statement) => statement.sql.includes("status='blocked'")))).toBe(true);
    expect(db.batches.length).toBeLessThanOrEqual(21);
  });

  it('round-robins a large backlog so another due template is not starved', async () => {
    const db = new GenerationDb([{ ...scheduledRow, id: 'scheduled-backlog', frequency: 'daily' }, { ...scheduledRow, id: 'scheduled-later', frequency: 'daily' }]);
    const result = await new Repository(db as never).generateDueScheduledExpenses('2026-01-30');
    const generations = db.batches.filter((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO expenses')));
    const generatedFor = (id: string) => generations.filter((batch) => batch[0].args[1] === id).length;
    expect(result).toMatchObject({ generated: 20, processed: 20, capped: true });
    expect(generatedFor('scheduled-backlog')).toBe(10);
    expect(generatedFor('scheduled-later')).toBe(10);
  });

  it('rotates the bounded candidate window so the 21st due template is reached', async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      ...scheduledRow,
      id: `scheduled-${String(index + 1).padStart(2, '0')}`,
      frequency: 'daily',
    }));
    const db = new GenerationDb(rows);
    const first = await new Repository(db as never).generateDueScheduledExpenses('2026-01-30');
    const second = await new Repository(db as never).generateDueScheduledExpenses('2026-01-30');
    const generations = db.batches.filter((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO expenses')));
    const generatedFor = (id: string) => generations.filter((batch) => batch[0].args[1] === id).length;
    expect(first).toMatchObject({ generated: 20, templatesScanned: 20, capped: true });
    expect(second).toMatchObject({ generated: 20, templatesScanned: 20, capped: true });
    expect(generatedFor('scheduled-21')).toBe(1);
    expect(db.cursorId).toBe('scheduled-19');
  });

  it('leaves a template due after its per-invocation catch-up cap', async () => {
    const db = new GenerationDb([{ ...scheduledRow, id: 'scheduled-backlog', frequency: 'daily' }]);
    const result = await new Repository(db as never).generateDueScheduledExpenses('2026-01-30', { maxOccurrences: 20, maxOccurrencesPerTemplate: 3 });
    expect(result).toMatchObject({ generated: 3, processed: 3, capped: true });
    expect(db.batches.filter((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO expenses')))).toHaveLength(3);
  });

  it('keeps every generation statement below D1 bind limits for many participants', async () => {
    const db = new GenerationDb(); db.participantCount = 82;
    const result = await new Repository(db as never).generateDueScheduledExpenses('2026-01-02');
    expect(result.generated).toBe(1);
    const generation = db.batches.find((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO expenses')))!;
    expect(Math.max(...generation.map((statement) => statement.args.length))).toBeLessThan(100);
    expect(generation.filter((statement) => statement.sql.includes('INSERT INTO payers') || statement.sql.includes('INSERT INTO splits'))).toHaveLength(2);
    expect(generation.some((statement) => statement.sql.includes('person_id IN ('))).toBe(false);
  });

  it('blocks a permanent generation failure per template and continues with later schedules', async () => {
    const db = new GenerationDb([{ ...scheduledRow, id: 'scheduled-invalid' }, { ...scheduledRow, id: 'scheduled-later' }]);
    db.permanentForFirst = true;
    const result = await new Repository(db as never).generateDueScheduledExpenses('2026-01-02');
    expect(result).toMatchObject({ generated: 1, blocked: 1 });
    expect(db.batches.some((batch) => batch.some((statement) => statement.sql.includes("status='blocked'")))).toBe(true);
  });

  it('does not use a forgeable expense operation for generation and blocks unrelated uniqueness collisions while continuing', async () => {
    const db = new GenerationDb([{ ...scheduledRow, id: 'scheduled-collision' }, { ...scheduledRow, id: 'scheduled-later' }]);
    db.uniqueForFirst = true;
    const result = await new Repository(db as never).generateDueScheduledExpenses('2026-01-02');
    const generation = db.batches.find((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO expenses')))!;
    const expenseInsert = generation.find((statement) => statement.sql.includes('INSERT INTO expenses'))!;
    expect(expenseInsert.args[11]).toBeNull();
    expect(result).toMatchObject({ generated: 1, blocked: 1 });
    expect(db.batches.some((batch) => batch.some((statement) => statement.sql.includes("status='blocked'")))).toBe(true);
  });

  it('completes an occurrence at the edited end date and clears the cursor', async () => {
    const db = new GenerationDb([{ ...scheduledRow, end_date: '2026-01-01' } as Record<string, unknown>]);
    await new Repository(db as never).generateDueScheduledExpenses('2026-01-02');
    const generation = db.batches.find((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO expenses')))!;
    expect(generation.find((statement) => statement.sql.includes('SET status=CASE'))?.sql).toContain("'completed'");
    expect(generation.find((statement) => statement.sql.includes('SET status=CASE'))?.args[0]).toBeNull();
  });

  it('leaves transient generation failures retryable', async () => {
    const db = new GenerationDb();
    const original = db.batch.bind(db);
    db.batch = async (statements) => { if (statements.some((statement) => statement.sql.includes('INSERT INTO expenses'))) throw new Error('D1 temporarily unavailable'); return original(statements); };
    await expect(new Repository(db as never).generateDueScheduledExpenses('2026-01-02')).rejects.toThrow('temporarily unavailable');
    expect(db.batches.some((batch) => batch.some((statement) => statement.sql.includes("status='blocked'")))).toBe(false);
  });

  it('rejects a stale pause that interleaves after Cron advances and completes the cursor', async () => {
    const db = new CronStatusInterleavedDb();
    const repository = new Repository(db as never);
    const pause = repository.pauseScheduledExpense('scheduled-1', 1);
    await db.statusReady;
    await repository.generateDueScheduledExpenses('2026-01-02');
    db.allowStatusUpdate();
    await expect(pause).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.row.status).toBe('completed');
    expect(db.row.generation_claim_id).toBeNull();
    expect(db.row.version).toBe(2);
  });
});
