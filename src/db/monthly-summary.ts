import type { D1Database } from '@cloudflare/workers-types';

type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? '');
const number = (value: unknown) => Number(value ?? 0);
const now = () => new Date().toISOString();
const epoch = () => Date.now();
const id = () => crypto.randomUUID();
// Leave enough room for several D1 subrequests in one bounded invocation;
// ownership is still checked and renewed before every state-changing unit.
const leaseLengthMs = 300_000;
const nextMonth = (month: string) => { const value = new Date(`${month}T00:00:00Z`); value.setUTCMonth(value.getUTCMonth() + 1); return value.toISOString().slice(0, 10); };
export const previousMonth = (date: string) => { const value = new Date(`${date.slice(0, 7)}-01T00:00:00Z`); value.setUTCMonth(value.getUTCMonth() - 1); return value.toISOString().slice(0, 10); };
const changed = (result: unknown, fallback = 1) => Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? fallback);
const encodeKey = (date: string, key: string) => JSON.stringify({ date, id: key });
const decodeKey = (value: unknown): { date: string; id: string } | null => {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(text(value)) as { date?: unknown; id?: unknown };
    if (typeof parsed.date !== 'string' || typeof parsed.id !== 'string') return null;
    return { date: parsed.date, id: parsed.id };
  } catch { return null; }
};
const sameKey = (left: { date: string; id: string } | null, right: { date: string; id: string } | null) => left?.date === right?.date && left?.id === right?.id;

export type MaintenanceOptions = { maxGroups?: number; maxMonths?: number; chunkSize?: number; deadlineMs?: number };
const hasTime = (deadlineMs?: number, reserveMs = 25) => deadlineMs == null || Date.now() + reserveMs < deadlineMs;
const retryAt = () => epoch() + 60_000;

type GarbageCollectionResult = {
  buildsScanned: number; buildsCompleted: number; balancesDeleted: number; totalsDeleted: number; capped: boolean;
};

/** Delete one exact superseded build in bounded, fair chunks. */
export async function ledgerPeriodBuildGarbageCollection(db: D1Database, options: { maxBuilds?: number; chunkSize?: number; deadlineMs?: number } = {}): Promise<GarbageCollectionResult> {
  const maxBuilds = Math.min(Math.max(options.maxBuilds ?? 1, 0), 10);
  const chunkSize = Math.min(Math.max(options.chunkSize ?? 100, 1), 100);
  if (!hasTime(options.deadlineMs)) return { buildsScanned: 0, buildsCompleted: 0, balancesDeleted: 0, totalsDeleted: 0, capped: true };
  const current = epoch();
  const candidates = (await db.prepare(`SELECT group_id,month,build_id FROM ledger_period_build_gc
    WHERE available_at_ms<=? AND (lease_until_ms IS NULL OR lease_until_ms<=?)
      AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=ledger_period_build_gc.group_id AND p.month=ledger_period_build_gc.month
        AND (p.active_build_id=ledger_period_build_gc.build_id OR p.build_id=ledger_period_build_gc.build_id))
    ORDER BY available_at_ms,last_served_at_ms,enqueued_at_ms,group_id,month,build_id LIMIT ?`).bind(current, current, maxBuilds).all<Row>()).results;
  let buildsCompleted = 0, balancesDeleted = 0, totalsDeleted = 0, incomplete = false;
  for (const candidate of candidates) {
    if (!hasTime(options.deadlineMs)) { incomplete = true; break; }
    const groupId = text(candidate.group_id), month = text(candidate.month), buildId = text(candidate.build_id), owner = id(), until = epoch() + leaseLengthMs;
    const claimed = await db.prepare(`UPDATE ledger_period_build_gc SET lease_owner=?,lease_until_ms=?,attempt_count=attempt_count+1,last_served_at_ms=?,updated_at_ms=?
      WHERE group_id=? AND month=? AND build_id=? AND available_at_ms<=? AND (lease_owner IS NULL OR lease_until_ms<=?)
        AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=ledger_period_build_gc.group_id AND p.month=ledger_period_build_gc.month
          AND (p.active_build_id=ledger_period_build_gc.build_id OR p.build_id=ledger_period_build_gc.build_id))`).bind(owner, until, current, current, groupId, month, buildId, current, current).run();
    if (changed(claimed, 0) === 0) {
      // Some local D1 adapters omit changes metadata. Read back ownership
      // rather than treating a stale claim as successful (or fabricating it).
      const owned = await db.prepare(`SELECT lease_owner,lease_until_ms FROM ledger_period_build_gc
        WHERE group_id=? AND month=? AND build_id=? AND lease_owner=? AND lease_until_ms>?`).bind(groupId, month, buildId, owner, current).first<Row>();
      if (text(owned?.lease_owner) !== owner || number(owned?.lease_until_ms) <= current) continue;
    }
    try {
      if (!hasTime(options.deadlineMs)) {
        incomplete = true;
        await db.prepare(`UPDATE ledger_period_build_gc SET lease_owner=NULL,lease_until_ms=NULL,available_at_ms=?,updated_at_ms=?
          WHERE group_id=? AND month=? AND build_id=? AND lease_owner=?`).bind(epoch(), epoch(), groupId, month, buildId, owner).run();
        continue;
      }
      const at = epoch();
      const result = await db.batch([
        // Both deletes repeat the active/current-build guard at execution time.
        // An old queue row can therefore never remove a visible or in-progress build.
        db.prepare(`DELETE FROM ledger_period_balances WHERE rowid IN (
          SELECT rowid FROM ledger_period_balances b WHERE b.group_id=? AND b.month=? AND b.build_id=?
            AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=b.group_id AND p.month=b.month AND (p.active_build_id=b.build_id OR p.build_id=b.build_id)) LIMIT ?)`).bind(groupId, month, buildId, chunkSize),
        db.prepare(`DELETE FROM ledger_period_totals WHERE rowid IN (
          SELECT rowid FROM ledger_period_totals t WHERE t.group_id=? AND t.month=? AND t.build_id=?
            AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=t.group_id AND p.month=t.month AND (p.active_build_id=t.build_id OR p.build_id=t.build_id)) LIMIT ?)`).bind(groupId, month, buildId, chunkSize),
      ]);
      balancesDeleted += changed(result[0], 0);
      totalsDeleted += changed(result[1], 0);
      if (!hasTime(options.deadlineMs)) {
        incomplete = true;
        await db.prepare(`UPDATE ledger_period_build_gc SET lease_owner=NULL,lease_until_ms=NULL,available_at_ms=?,updated_at_ms=?
          WHERE group_id=? AND month=? AND build_id=? AND lease_owner=?`).bind(epoch(), epoch(), groupId, month, buildId, owner).run();
        continue;
      }
      const remaining = await db.prepare(`SELECT
        EXISTS (SELECT 1 FROM ledger_period_balances b WHERE b.group_id=? AND b.month=? AND b.build_id=?) AS balances,
        EXISTS (SELECT 1 FROM ledger_period_totals t WHERE t.group_id=? AND t.month=? AND t.build_id=?) AS totals,
        EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND p.month=? AND (p.active_build_id=? OR p.build_id=?)) AS referenced`).bind(groupId, month, buildId, groupId, month, buildId, groupId, month, buildId, buildId).first<Row>();
      const done = !Number(remaining?.balances) && !Number(remaining?.totals) && !Number(remaining?.referenced);
      if (done) {
        if (!hasTime(options.deadlineMs)) {
          incomplete = true;
          await db.prepare(`UPDATE ledger_period_build_gc SET lease_owner=NULL,lease_until_ms=NULL,available_at_ms=?,updated_at_ms=?
            WHERE group_id=? AND month=? AND build_id=? AND lease_owner=?`).bind(epoch(), epoch(), groupId, month, buildId, owner).run();
          continue;
        }
        const removed = await db.prepare(`DELETE FROM ledger_period_build_gc WHERE group_id=? AND month=? AND build_id=?
          AND lease_owner=?
          AND NOT EXISTS (SELECT 1 FROM ledger_period_balances b WHERE b.group_id=? AND b.month=? AND b.build_id=?)
          AND NOT EXISTS (SELECT 1 FROM ledger_period_totals t WHERE t.group_id=? AND t.month=? AND t.build_id=?)
          AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND p.month=? AND (p.active_build_id=? OR p.build_id=?))`).bind(groupId, month, buildId, owner, groupId, month, buildId, groupId, month, buildId, groupId, month, buildId, buildId).run();
        if (changed(removed, 0) > 0) buildsCompleted += 1;
        else {
          if (!hasTime(options.deadlineMs)) {
            incomplete = true;
            await db.prepare(`UPDATE ledger_period_build_gc SET lease_owner=NULL,lease_until_ms=NULL,available_at_ms=?,updated_at_ms=?
              WHERE group_id=? AND month=? AND build_id=? AND lease_owner=?`).bind(epoch(), epoch(), groupId, month, buildId, owner).run();
            continue;
          }
          const stillQueued = await db.prepare('SELECT 1 FROM ledger_period_build_gc WHERE group_id=? AND month=? AND build_id=?').bind(groupId, month, buildId).first<Row>();
          if (!stillQueued) buildsCompleted += 1;
          else await db.prepare(`UPDATE ledger_period_build_gc SET lease_owner=NULL,lease_until_ms=NULL,available_at_ms=?,updated_at_ms=?
            WHERE group_id=? AND month=? AND build_id=? AND lease_owner=?`).bind(epoch(), epoch(), groupId, month, buildId, owner).run();
        }
      } else {
        incomplete = true;
        // Serving an unfinished build updates fairness metadata and puts it
        // behind newly available entries on the next invocation.
        await db.prepare(`UPDATE ledger_period_build_gc SET lease_owner=NULL,lease_until_ms=NULL,available_at_ms=?,last_error=NULL,updated_at_ms=?
          WHERE group_id=? AND month=? AND build_id=? AND lease_owner=?`).bind(at, at, groupId, month, buildId, owner).run();
      }
      // A caller can enqueue a build after it becomes active. It is excluded
      // from candidate selection for safety, but remove that obsolete queue
      // row once this invocation has done real GC work so it cannot linger
      // behind unrelated orphan builds.
      await db.prepare(`DELETE FROM ledger_period_build_gc WHERE group_id=? AND month=?
        AND EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND p.month=? AND p.active_build_id=ledger_period_build_gc.build_id)`).bind(groupId, month, groupId, month).run();
    } catch (error) {
      incomplete = true;
      await db.prepare(`UPDATE ledger_period_build_gc SET lease_owner=NULL,lease_until_ms=NULL,available_at_ms=?,last_error=?,updated_at_ms=?
        WHERE group_id=? AND month=? AND build_id=? AND lease_owner=?`).bind(retryAt(), error instanceof Error ? error.message.slice(0, 500) : 'build garbage collection failed', epoch(), groupId, month, buildId, owner).run();
    }
  }
  return { buildsScanned: candidates.length, buildsCompleted, balancesDeleted, totalsDeleted, capped: incomplete || candidates.length >= maxBuilds };
}

export async function monthlySummaryMaintenance(db: D1Database, options: MaintenanceOptions = {}) {
  const maxGroups = Math.min(Math.max(options.maxGroups ?? 2, 1), 10);
  const maxMonths = Math.min(Math.max(options.maxMonths ?? 4, 1), 12);
  const chunkSize = Math.min(Math.max(options.chunkSize ?? 100, 1), 100);
  const selectedAt = epoch();
  const groups = hasTime(options.deadlineMs) ? (await db.prepare(`SELECT state.group_id FROM ledger_summary_state state JOIN groups g ON g.id=state.group_id
    WHERE g.deleted_at IS NULL AND state.maintenance_due=1 AND state.available_at_ms<=?
      AND (state.lease_until_ms IS NULL OR state.lease_until_ms<=?)
    ORDER BY state.maintenance_due,state.available_at_ms,state.updated_at,state.group_id LIMIT ?`).bind(selectedAt, selectedAt, maxGroups).all<Row>()).results : [];
  let monthsScanned = 0, monthsVerified = 0, chunks = 0, groupsFailed = 0, monthsFailed = 0;
  for (const row of groups) {
    if (!hasTime(options.deadlineMs)) break;
    const groupId = text(row.group_id), owner = id(), acquired = await acquireGroupLease(db, groupId, owner);
    if (!acquired) continue;
    try {
      const discovered = await discoverMonths(db, groupId, owner, chunkSize, options.deadlineMs);
      if (discovered && hasTime(options.deadlineMs)) {
        const months = (await db.prepare(`SELECT month FROM ledger_period_state
          WHERE group_id=? AND (status<>'ready' OR source_generation<>applied_generation OR active_build_id IS NULL)
            AND (retry_at_ms IS NULL OR retry_at_ms<=?) ORDER BY month LIMIT ?`).bind(groupId, epoch(), maxMonths).all<Row>()).results;
        for (const monthRow of months) {
          if (monthsScanned >= maxGroups * maxMonths || !hasTime(options.deadlineMs)) break;
          const month = text(monthRow.month); monthsScanned += 1;
          try {
            const result = await maintainMonth(db, groupId, month, owner, chunkSize, options.deadlineMs);
            chunks += result.chunks;
            if (result.verified) monthsVerified += 1;
          } catch (error) {
            monthsFailed += 1;
            const retry = retryAt(), message = error instanceof Error ? error.message.slice(0, 500) : 'month maintenance failed';
            await db.batch([
              db.prepare(`UPDATE ledger_period_state SET status='failed',retry_count=retry_count+1,retry_at_ms=?,last_error=?,updated_at=?
                WHERE group_id=? AND month=? AND lease_owner=? AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.lease_until_ms>?)`).bind(retry, message, now(), groupId, month, owner, groupId, owner, epoch()),
              db.prepare(`UPDATE ledger_summary_state SET maintenance_due=1,available_at_ms=?,updated_at=? WHERE group_id=? AND lease_owner=?`).bind(retry, now(), groupId, owner),
            ]);
          }
        }
        const renewedForFold = hasTime(options.deadlineMs) && await renewGroupLease(db, groupId, owner);
        if (renewedForFold) {
          await foldOneMonth(db, groupId, owner, options.deadlineMs);
          const renewedForPublish = hasTime(options.deadlineMs) && await renewGroupLease(db, groupId, owner);
           if (renewedForPublish) await publish(db, groupId, owner, options.deadlineMs);
        }
      }
      // Compute the next queue time before releasing the group lease. The
      // release must not replace this value with an artificial FIFO head.
      await scheduleSummaryAvailability(db, groupId, owner);
      await yieldGroupLease(db, groupId, owner);
    } catch (error) {
      groupsFailed += 1;
      const retry = retryAt();
      await db.prepare(`UPDATE ledger_summary_state SET status='failed',maintenance_due=1,available_at_ms=?,retry_count=retry_count+1,last_error=?,updated_at=?
        WHERE group_id=? AND lease_owner=?`).bind(retry, error instanceof Error ? error.message.slice(0, 500) : 'summary maintenance failed', now(), groupId, owner).run();
    } finally {
      await db.prepare('UPDATE ledger_summary_state SET lease_owner=NULL,lease_until_ms=NULL WHERE group_id=? AND lease_owner=?').bind(groupId, owner).run();
    }
  }
  return { groupsScanned: groups.length, monthsScanned, monthsVerified, chunks, groupsFailed, monthsFailed, capped: groups.length >= maxGroups || monthsScanned >= maxGroups * maxMonths || !hasTime(options.deadlineMs) };
}

async function acquireGroupLease(db: D1Database, groupId: string, owner: string) {
  const current = epoch(), until = current + leaseLengthMs;
  const result = await db.prepare(`UPDATE ledger_summary_state SET status='backfilling',maintenance_due=1,lease_owner=?,lease_until_ms=?,updated_at=?
    WHERE group_id=? AND maintenance_due=1 AND available_at_ms<=?
      AND (lease_owner IS NULL OR lease_until_ms IS NULL OR lease_until_ms<=?)
      AND EXISTS (SELECT 1 FROM groups g WHERE g.id=ledger_summary_state.group_id AND g.deleted_at IS NULL)`).bind(owner, until, now(), groupId, current, current).run();
  if (changed(result, 0) > 0) return true;
  const row = await db.prepare(`SELECT state.lease_owner,state.lease_until_ms FROM ledger_summary_state state
    JOIN groups g ON g.id=state.group_id
    WHERE state.group_id=? AND g.deleted_at IS NULL AND state.maintenance_due=1 AND state.available_at_ms<=?
      AND state.lease_owner=? AND state.lease_until_ms>?`).bind(groupId, current, owner, current).first<Row>();
  return text(row?.lease_owner) === owner && number(row?.lease_until_ms) > current;
}

export async function renewGroupLease(db: D1Database, groupId: string, owner: string, at = epoch()) {
  const result = await db.prepare(`UPDATE ledger_summary_state SET lease_until_ms=?,updated_at=? WHERE group_id=? AND lease_owner=? AND lease_until_ms>?`).bind(at + leaseLengthMs, now(), groupId, owner, at).run();
  if (changed(result, 0) > 0) return true;
  const current = await db.prepare('SELECT lease_owner,lease_until_ms FROM ledger_summary_state WHERE group_id=?').bind(groupId).first<Row>();
  return text(current?.lease_owner) === owner && number(current?.lease_until_ms) > at;
}

export async function renewPeriodLease(db: D1Database, groupId: string, month: string, owner: string, at = epoch()) {
  const result = await db.prepare(`UPDATE ledger_period_state SET lease_until_ms=?,updated_at=? WHERE group_id=? AND month=? AND lease_owner=? AND lease_until_ms>?`).bind(at + leaseLengthMs, now(), groupId, month, owner, at).run();
  if (changed(result, 0) > 0) return true;
  const current = await db.prepare('SELECT lease_owner,lease_until_ms FROM ledger_period_state WHERE group_id=? AND month=?').bind(groupId, month).first<Row>();
  return text(current?.lease_owner) === owner && number(current?.lease_until_ms) > at;
}

async function discoverMonths(db: D1Database, groupId: string, owner: string, chunkSize: number, deadlineMs?: number) {
  const discoveryLease = await renewGroupLease(db, groupId, owner);
  if (!hasTime(deadlineMs) || !discoveryLease) return false;
  await db.prepare(`UPDATE ledger_summary_state SET
      expense_discovery_high_water=COALESCE(expense_discovery_high_water,(SELECT id FROM expenses WHERE group_id=? ORDER BY id DESC LIMIT 1)),
      settlement_discovery_high_water=COALESCE(settlement_discovery_high_water,(SELECT id FROM settlements WHERE group_id=? ORDER BY id DESC LIMIT 1)),
      updated_at=? WHERE group_id=? AND lease_owner=? AND lease_until_ms>?`).bind(groupId, groupId, now(), groupId, owner, epoch()).run();
  const state = await db.prepare('SELECT * FROM ledger_summary_state WHERE group_id=? AND lease_owner=? AND lease_until_ms>?').bind(groupId, owner, epoch()).first<Row>();
  if (!state) return false;
  const discover = async (table: 'expenses' | 'settlements', dateColumn: 'expense_date' | 'settlement_date', cursorColumn: string, highColumn: string) => {
    if (!hasTime(deadlineMs) || !await renewGroupLease(db, groupId, owner)) return false;
    const cursor = state[cursorColumn] == null ? '' : text(state[cursorColumn]), high = state[highColumn] == null ? null : text(state[highColumn]);
    if (high === null || cursor === high) return true;
    const rows = (await db.prepare(`SELECT id,${dateColumn} AS transaction_date FROM ${table}
      WHERE group_id=? AND id>? AND id<=? ORDER BY id LIMIT ?`).bind(groupId, cursor, high, chunkSize).all<Row>()).results;
    if (rows.length) {
      if (!hasTime(deadlineMs) || !await renewGroupLease(db, groupId, owner)) return false;
      const months = JSON.stringify(rows.map((row) => ({ month: `${text(row.transaction_date).slice(0, 7)}-01` }))), last = text(rows[rows.length - 1].id), previous = state[cursorColumn] == null ? null : text(state[cursorColumn]);
      const result = await db.batch([
        db.prepare(`INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
          SELECT ?,json_extract(value,'$.month'),'pending',0,? FROM json_each(?)
          WHERE EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.lease_until_ms>?)
          ON CONFLICT(group_id,month) DO NOTHING`).bind(groupId, now(), months, groupId, owner, epoch()),
        db.prepare(`UPDATE ledger_summary_state SET ${cursorColumn}=? WHERE group_id=? AND lease_owner=? AND ${cursorColumn} IS ? AND ${highColumn} IS ? AND lease_until_ms>?`).bind(last, groupId, owner, previous, high, epoch()),
      ]);
      if (changed(result[1], 0) === 0) return false;
      state[cursorColumn] = last;
      return false;
    }
    const previous = state[cursorColumn] == null ? null : text(state[cursorColumn]);
    const result = await db.prepare(`UPDATE ledger_summary_state SET ${cursorColumn}=? WHERE group_id=? AND lease_owner=? AND ${cursorColumn} IS ? AND ${highColumn} IS ? AND lease_until_ms>?`).bind(high, groupId, owner, previous, high, epoch()).run();
    if (changed(result, 0) === 0) return false;
    state[cursorColumn] = high;
    return true;
  };
  const expensesDone = await discover('expenses', 'expense_date', 'expense_discovery_cursor', 'expense_discovery_high_water');
  const settlementsDone = await discover('settlements', 'settlement_date', 'settlement_discovery_cursor', 'settlement_discovery_high_water');
  if (!expensesDone || !settlementsDone || !hasTime(deadlineMs)) return false;
  const queueTime = epoch();
  await db.prepare(`UPDATE ledger_summary_state SET discovery_complete=1,maintenance_due=1,available_at_ms=?,updated_at=?
    WHERE group_id=? AND lease_owner=? AND lease_until_ms>?
      AND (expense_discovery_high_water IS NULL OR expense_discovery_cursor IS expense_discovery_high_water)
      AND (settlement_discovery_high_water IS NULL OR settlement_discovery_cursor IS settlement_discovery_high_water)`).bind(queueTime, now(), groupId, owner, epoch()).run();
  const completed = await db.prepare('SELECT discovery_complete FROM ledger_summary_state WHERE group_id=? AND lease_owner=? AND lease_until_ms>?').bind(groupId, owner, epoch()).first<Row>();
  return number(completed?.discovery_complete) === 1;
}

async function maintainMonth(db: D1Database, groupId: string, month: string, owner: string, chunkSize: number, deadlineMs?: number) {
  try {
    return await maintainMonthWork(db, groupId, month, owner, chunkSize, deadlineMs);
  } catch (error) {
    // Record a retry while the period lease still proves that this invocation
    // owns the work. The finally release below must not make the caller's
    // later error handler accidentally update a replacement owner's period.
    try {
      await db.prepare(`UPDATE ledger_period_state SET status='failed',retry_count=retry_count+1,retry_at_ms=?,last_error=?,updated_at=?
        WHERE group_id=? AND month=? AND lease_owner=? AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.lease_until_ms>?)`)
        .bind(retryAt(), error instanceof Error ? error.message.slice(0, 500) : 'month maintenance failed', now(), groupId, month, owner, groupId, owner, epoch()).run();
    } catch {
      // Preserve the original maintenance error; the next invocation can
      // recover the hidden build after the ownership release.
    }
    throw error;
  } finally {
    // A yielded or failed invocation must not leave the five-minute period
    // lease blocking the next owner. Hidden build IDs and cursors are retained
    // by the work function, so the next invocation can resume immediately.
    await db.prepare(`UPDATE ledger_period_state SET lease_owner=NULL,lease_until_ms=NULL
      WHERE group_id=? AND month=? AND lease_owner=?`).bind(groupId, month, owner).run();
  }
}

async function maintainMonthWork(db: D1Database, groupId: string, month: string, owner: string, chunkSize: number, deadlineMs?: number) {
  let state = await db.prepare('SELECT p.*,s.checkpoint_through FROM ledger_period_state p JOIN ledger_summary_state s ON s.group_id=p.group_id WHERE p.group_id=? AND p.month=?').bind(groupId, month).first<Row>();
  if (!state) return { chunks: 0, verified: false };
  if (text(state.status) === 'ready' && number(state.source_generation) === number(state.applied_generation) && state.active_build_id != null) return { chunks: 0, verified: false };
  if (!hasTime(deadlineMs) || !await renewGroupLease(db, groupId, owner)) return { chunks: 0, verified: false };
  const source = number(state.source_generation), newBuild = id(), reset = text(state.status) !== 'backfilling' || number(state.build_generation) !== source || state.build_id == null;
  const build = reset ? newBuild : text(state.build_id), until = epoch() + leaseLengthMs;
  if (reset) {
    const expenseHigh = await db.prepare(`SELECT expense_date AS date,id FROM expenses WHERE group_id=? AND expense_date>=? AND expense_date<? ORDER BY expense_date DESC,id DESC LIMIT 1`).bind(groupId, month, nextMonth(month)).first<Row>();
    const settlementHigh = await db.prepare(`SELECT settlement_date AS date,id FROM settlements WHERE group_id=? AND settlement_date>=? AND settlement_date<? ORDER BY settlement_date DESC,id DESC LIMIT 1`).bind(groupId, month, nextMonth(month)).first<Row>();
    const oldBuild = state.build_id == null ? null : text(state.build_id), activeBuild = state.active_build_id == null ? null : text(state.active_build_id), queueTime = epoch();
    const statements = [];
    if (oldBuild && oldBuild !== activeBuild) statements.push(db.prepare(`INSERT INTO ledger_period_build_gc(group_id,month,build_id,enqueued_at_ms,available_at_ms,updated_at_ms)
      SELECT group_id,month,?, ?,?,? FROM ledger_period_state
      WHERE group_id=? AND month=? AND build_id=? AND build_id<>COALESCE(active_build_id,'') AND EXISTS
        (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.lease_until_ms>?)
      ON CONFLICT(group_id,month,build_id) DO NOTHING`).bind(oldBuild, queueTime, queueTime, queueTime, groupId, month, oldBuild, groupId, owner, epoch()));
    statements.push(db.prepare(`UPDATE ledger_period_state SET status='backfilling',build_generation=source_generation,build_id=?,
        expense_cursor=NULL,settlement_cursor=NULL,expense_high_water=?,settlement_high_water=?,lease_owner=?,lease_until_ms=?,retry_at_ms=NULL,last_error=NULL,updated_at=?
      WHERE group_id=? AND month=? AND source_generation=? AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.lease_until_ms>?)`)
      .bind(build, expenseHigh ? encodeKey(text(expenseHigh.date), text(expenseHigh.id)) : null, settlementHigh ? encodeKey(text(settlementHigh.date), text(settlementHigh.id)) : null, owner, until, now(), groupId, month, source, groupId, owner, epoch()));
    await db.batch(statements);
  } else {
    await db.prepare(`UPDATE ledger_period_state SET lease_owner=?,lease_until_ms=?,updated_at=?
      WHERE group_id=? AND month=? AND status='backfilling' AND build_id=? AND build_generation=? AND source_generation=?
        AND (lease_owner=? OR lease_until_ms IS NULL OR lease_until_ms<=?)
        AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.lease_until_ms>?)`)
      .bind(owner, until, now(), groupId, month, build, source, source, owner, epoch(), groupId, owner, epoch()).run();
  }
  state = await db.prepare('SELECT p.*,s.checkpoint_through FROM ledger_period_state p JOIN ledger_summary_state s ON s.group_id=p.group_id WHERE p.group_id=? AND p.month=?').bind(groupId, month).first<Row>();
  if (!state || text(state.build_id) !== build || text(state.lease_owner) !== owner || !await renewPeriodLease(db, groupId, month, owner)) return { chunks: 0, verified: false };
  const buildGeneration = number(state.build_generation), sourceGeneration = number(state.source_generation), expectedCheckpoint = state.checkpoint_through == null ? null : text(state.checkpoint_through);
  let expenseCursor = decodeKey(state.expense_cursor), settlementCursor = decodeKey(state.settlement_cursor);
  const expenseHigh = decodeKey(state.expense_high_water), settlementHigh = decodeKey(state.settlement_high_water);
  const guard = (expenseExpected: string | null, settlementExpected: string | null) => ({
    sql: `EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.lease_until_ms>?)
      AND EXISTS (SELECT 1 FROM ledger_summary_state s2 WHERE s2.group_id=? AND s2.lease_owner=? AND s2.checkpoint_through IS ? AND s2.status='backfilling' AND s2.lease_until_ms>?)
      AND EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND p.month=? AND p.status='backfilling' AND p.lease_owner=? AND p.build_id=? AND p.build_generation=? AND p.source_generation=? AND p.expense_cursor IS ? AND p.settlement_cursor IS ? AND p.lease_until_ms>?)`,
    args: [groupId, owner, epoch(), groupId, owner, expectedCheckpoint, epoch(), groupId, month, owner, build, buildGeneration, sourceGeneration, expenseExpected, settlementExpected, epoch()],
  });
  let count = 0;
  const readChunk = async (table: 'expenses' | 'settlements', dateColumn: 'expense_date' | 'settlement_date', cursor: { date: string; id: string } | null, high: { date: string; id: string } | null) => {
    if (!high || sameKey(cursor, high)) return [] as Row[];
    if (!hasTime(deadlineMs)) return null;
    const after = cursor ? `((${dateColumn}>?) OR (${dateColumn}=? AND id>?))` : '1=1', before = `(${dateColumn}<? OR (${dateColumn}=? AND id<=?))`, args: unknown[] = [groupId, month, nextMonth(month)];
    if (cursor) args.push(cursor.date, cursor.date, cursor.id);
    args.push(high.date, high.date, high.id, chunkSize);
    return (await db.prepare(`SELECT id,${dateColumn} AS transaction_date FROM ${table} WHERE group_id=? AND ${dateColumn}>=? AND ${dateColumn}<? AND ${after} AND ${before} ORDER BY ${dateColumn},id LIMIT ?`).bind(...args).all<Row>()).results;
  };
  const expenseRows = await readChunk('expenses', 'expense_date', expenseCursor, expenseHigh);
  if (expenseRows === null) return { chunks: count, verified: false };
  if (expenseRows.length) {
    if (!hasTime(deadlineMs) || !await renewGroupLease(db, groupId, owner) || !await renewPeriodLease(db, groupId, month, owner)) return { chunks: count, verified: false };
    const ids = expenseRows.map((value) => text(value.id)), last = { date: text(expenseRows[expenseRows.length - 1].transaction_date), id: ids[ids.length - 1] }, g = guard(state.expense_cursor == null ? null : text(state.expense_cursor), state.settlement_cursor == null ? null : text(state.settlement_cursor)), encoded = JSON.stringify(ids);
    await db.batch([
      db.prepare(`INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT e.group_id,?, ?,e.currency,p.person_id,SUM(p.amount_minor),? FROM expenses e JOIN payers p ON p.expense_id=e.id WHERE e.id IN (SELECT value FROM json_each(?)) AND e.deleted_at IS NULL AND ${g.sql} GROUP BY e.group_id,e.currency,p.person_id ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT e.group_id,?, ?,e.currency,s.person_id,-SUM(s.amount_minor),? FROM expenses e JOIN splits s ON s.expense_id=e.id WHERE e.id IN (SELECT value FROM json_each(?)) AND e.deleted_at IS NULL AND ${g.sql} GROUP BY e.group_id,e.currency,s.person_id ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`INSERT INTO ledger_period_totals(group_id,month,build_id,currency,gross_minor,updated_at) SELECT group_id,?, ?,currency,SUM(amount_minor),? FROM expenses WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND ${g.sql} GROUP BY group_id,currency ON CONFLICT(group_id,month,build_id,currency) DO UPDATE SET gross_minor=ledger_period_totals.gross_minor+excluded.gross_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`UPDATE ledger_period_state SET expense_cursor=?,updated_at=? WHERE group_id=? AND month=? AND expense_cursor IS ? AND ${g.sql}`).bind(encodeKey(last.date, last.id), now(), groupId, month, state.expense_cursor == null ? null : text(state.expense_cursor), ...g.args),
    ]);
    expenseCursor = last; state.expense_cursor = encodeKey(last.date, last.id); count += 1;
  } else if (expenseHigh && !sameKey(expenseCursor, expenseHigh)) {
    const g = guard(state.expense_cursor == null ? null : text(state.expense_cursor), state.settlement_cursor == null ? null : text(state.settlement_cursor));
    const result = await db.prepare(`UPDATE ledger_period_state SET expense_cursor=? WHERE group_id=? AND month=? AND expense_cursor IS ? AND ${g.sql}`).bind(encodeKey(expenseHigh.date, expenseHigh.id), groupId, month, state.expense_cursor == null ? null : text(state.expense_cursor), ...g.args).run();
    if (changed(result, 0) === 0) return { chunks: count, verified: false }; expenseCursor = expenseHigh; state.expense_cursor = encodeKey(expenseHigh.date, expenseHigh.id);
  }
  const settlementRows = await readChunk('settlements', 'settlement_date', settlementCursor, settlementHigh);
  if (settlementRows === null) return { chunks: count, verified: false };
  if (settlementRows.length) {
    if (!hasTime(deadlineMs) || !await renewGroupLease(db, groupId, owner) || !await renewPeriodLease(db, groupId, month, owner)) return { chunks: count, verified: false };
    const ids = settlementRows.map((value) => text(value.id)), last = { date: text(settlementRows[settlementRows.length - 1].transaction_date), id: ids[ids.length - 1] }, g = guard(state.expense_cursor == null ? null : text(state.expense_cursor), state.settlement_cursor == null ? null : text(state.settlement_cursor)), encoded = JSON.stringify(ids);
    await db.batch([
      db.prepare(`INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT group_id,?, ?,currency,from_person_id,SUM(amount_minor),? FROM settlements WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND ${g.sql} GROUP BY group_id,currency,from_person_id ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT group_id,?, ?,currency,to_person_id,-SUM(amount_minor),? FROM settlements WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND ${g.sql} GROUP BY group_id,currency,to_person_id ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`INSERT INTO ledger_period_totals(group_id,month,build_id,currency,gross_minor,updated_at) SELECT group_id,?, ?,currency,SUM(amount_minor),? FROM settlements WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND ${g.sql} GROUP BY group_id,currency ON CONFLICT(group_id,month,build_id,currency) DO UPDATE SET gross_minor=ledger_period_totals.gross_minor+excluded.gross_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`UPDATE ledger_period_state SET settlement_cursor=?,updated_at=? WHERE group_id=? AND month=? AND settlement_cursor IS ? AND ${g.sql}`).bind(encodeKey(last.date, last.id), now(), groupId, month, state.settlement_cursor == null ? null : text(state.settlement_cursor), ...g.args),
    ]);
    settlementCursor = last; state.settlement_cursor = encodeKey(last.date, last.id); count += 1;
  } else if (settlementHigh && !sameKey(settlementCursor, settlementHigh)) {
    const g = guard(state.expense_cursor == null ? null : text(state.expense_cursor), state.settlement_cursor == null ? null : text(state.settlement_cursor));
    const result = await db.prepare(`UPDATE ledger_period_state SET settlement_cursor=? WHERE group_id=? AND month=? AND settlement_cursor IS ? AND ${g.sql}`).bind(encodeKey(settlementHigh.date, settlementHigh.id), groupId, month, state.settlement_cursor == null ? null : text(state.settlement_cursor), ...g.args).run();
    if (changed(result, 0) === 0) return { chunks: count, verified: false }; settlementCursor = settlementHigh; state.settlement_cursor = encodeKey(settlementHigh.date, settlementHigh.id);
  }
  if (!sameKey(expenseCursor, expenseHigh) || !sameKey(settlementCursor, settlementHigh) || !hasTime(deadlineMs) || !await renewGroupLease(db, groupId, owner) || !await renewPeriodLease(db, groupId, month, owner)) return { chunks: count, verified: false };
  const expenseCursorText = expenseCursor ? encodeKey(expenseCursor.date, expenseCursor.id) : null, settlementCursorText = settlementCursor ? encodeKey(settlementCursor.date, settlementCursor.id) : null, g = guard(expenseCursorText, settlementCursorText);
  const publicationTime = now(), queueTime = epoch();
  const result = await db.batch([
    db.prepare(`WITH deltas AS (SELECT currency,person_id,net_minor AS delta FROM ledger_period_balances WHERE group_id=? AND month=? AND build_id=? UNION ALL SELECT currency,person_id,-net_minor FROM ledger_period_balances old WHERE old.group_id=? AND old.month=? AND old.build_id=(SELECT active_build_id FROM ledger_period_state WHERE group_id=? AND month=?)), grouped AS (SELECT currency,person_id,SUM(delta) AS delta FROM deltas GROUP BY currency,person_id) UPDATE ledger_checkpoint_balances AS checkpoint SET net_minor=checkpoint.net_minor+(SELECT delta FROM grouped WHERE grouped.currency=checkpoint.currency AND grouped.person_id=checkpoint.person_id),updated_at=? WHERE checkpoint.group_id=? AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.checkpoint_through IS ? AND s.checkpoint_through IS NOT NULL AND s.checkpoint_through>=?) AND EXISTS (SELECT 1 FROM grouped WHERE grouped.currency=checkpoint.currency AND grouped.person_id=checkpoint.person_id AND grouped.delta<>0) AND ${g.sql}`).bind(groupId, month, build, groupId, month, groupId, month, publicationTime, groupId, groupId, expectedCheckpoint, month, ...g.args),
    db.prepare(`WITH deltas AS (SELECT currency,person_id,net_minor AS delta FROM ledger_period_balances WHERE group_id=? AND month=? AND build_id=? UNION ALL SELECT currency,person_id,-net_minor FROM ledger_period_balances old WHERE old.group_id=? AND old.month=? AND old.build_id=(SELECT active_build_id FROM ledger_period_state WHERE group_id=? AND month=?)), grouped AS (SELECT currency,person_id,SUM(delta) AS delta FROM deltas GROUP BY currency,person_id) INSERT INTO ledger_checkpoint_balances(group_id,currency,person_id,net_minor,updated_at) SELECT ?,grouped.currency,grouped.person_id,grouped.delta,? FROM grouped WHERE grouped.delta<>0 AND NOT EXISTS (SELECT 1 FROM ledger_checkpoint_balances checkpoint WHERE checkpoint.group_id=? AND checkpoint.currency=grouped.currency AND checkpoint.person_id=grouped.person_id) AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.checkpoint_through IS ? AND s.checkpoint_through IS NOT NULL AND s.checkpoint_through>=?) AND ${g.sql}`).bind(groupId, month, build, groupId, month, groupId, month, groupId, publicationTime, groupId, groupId, expectedCheckpoint, month, ...g.args),
    db.prepare(`WITH deltas AS (SELECT currency,gross_minor AS delta FROM ledger_period_totals WHERE group_id=? AND month=? AND build_id=? UNION ALL SELECT currency,-gross_minor FROM ledger_period_totals old WHERE old.group_id=? AND old.month=? AND old.build_id=(SELECT active_build_id FROM ledger_period_state WHERE group_id=? AND month=?)), grouped AS (SELECT currency,SUM(delta) AS delta FROM deltas GROUP BY currency) UPDATE ledger_checkpoint_totals AS checkpoint SET gross_minor=checkpoint.gross_minor+(SELECT delta FROM grouped WHERE grouped.currency=checkpoint.currency),updated_at=? WHERE checkpoint.group_id=? AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.checkpoint_through IS ? AND s.checkpoint_through IS NOT NULL AND s.checkpoint_through>=?) AND EXISTS (SELECT 1 FROM grouped WHERE grouped.currency=checkpoint.currency AND grouped.delta<>0) AND checkpoint.gross_minor+(SELECT delta FROM grouped WHERE grouped.currency=checkpoint.currency) BETWEEN 0 AND 9007199254740991 AND ${g.sql}`).bind(groupId, month, build, groupId, month, groupId, month, publicationTime, groupId, groupId, expectedCheckpoint, month, ...g.args),
    db.prepare(`WITH deltas AS (SELECT currency,gross_minor AS delta FROM ledger_period_totals WHERE group_id=? AND month=? AND build_id=? UNION ALL SELECT currency,-gross_minor FROM ledger_period_totals old WHERE old.group_id=? AND old.month=? AND old.build_id=(SELECT active_build_id FROM ledger_period_state WHERE group_id=? AND month=?)), grouped AS (SELECT currency,SUM(delta) AS delta FROM deltas GROUP BY currency) INSERT INTO ledger_checkpoint_totals(group_id,currency,gross_minor,updated_at) SELECT ?,grouped.currency,grouped.delta,? FROM grouped WHERE grouped.delta<>0 AND grouped.delta>=0 AND NOT EXISTS (SELECT 1 FROM ledger_checkpoint_totals checkpoint WHERE checkpoint.group_id=? AND checkpoint.currency=grouped.currency) AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.checkpoint_through IS ? AND s.checkpoint_through IS NOT NULL AND s.checkpoint_through>=?) AND ${g.sql}`).bind(groupId, month, build, groupId, month, groupId, month, groupId, publicationTime, groupId, groupId, expectedCheckpoint, month, ...g.args),
    // Queue insertion is kept in this guarded publication batch below.
    db.prepare(`INSERT OR IGNORE INTO ledger_period_build_gc(group_id,month,build_id,enqueued_at_ms,available_at_ms,updated_at_ms)
      SELECT p.group_id,p.month,p.active_build_id,?,?,? FROM ledger_period_state p WHERE p.group_id=? AND p.month=?
        AND p.status='backfilling' AND p.build_id=? AND p.source_generation=p.build_generation
        AND p.active_build_id IS NOT NULL AND p.active_build_id<>p.build_id AND ${g.sql}`).bind(queueTime, queueTime, queueTime, groupId, month, build, ...g.args),
    db.prepare(`UPDATE ledger_period_state SET active_build_id=build_id,status='ready',applied_generation=build_generation,retry_at_ms=NULL,lease_owner=NULL,lease_until_ms=NULL,last_error=NULL,updated_at=? WHERE group_id=? AND month=? AND status='backfilling' AND build_id=? AND source_generation=build_generation AND expense_cursor IS ? AND settlement_cursor IS ? AND ${g.sql}`).bind(publicationTime, groupId, month, build, expenseCursorText, settlementCursorText, ...g.args),
  ]);
  return { chunks: count, verified: changed(result[result.length - 1], 0) > 0 };
}

async function foldOneMonth(db: D1Database, groupId: string, owner: string, deadlineMs?: number) {
  if (!hasTime(deadlineMs) || !await renewGroupLease(db, groupId, owner)) return;
  const state = await db.prepare("SELECT checkpoint_through FROM ledger_summary_state WHERE group_id=? AND lease_owner=? AND status='backfilling' AND lease_until_ms>? ").bind(groupId, owner, epoch()).first<Row>();
  if (!state) return;
  const through = state.checkpoint_through == null ? '0000-00-00' : text(state.checkpoint_through);
  const candidate = await db.prepare(`SELECT p.month,p.source_generation,p.applied_generation,p.build_generation,p.active_build_id,s.checkpoint_through FROM ledger_period_state p JOIN ledger_summary_state s ON s.group_id=p.group_id
    WHERE p.group_id=? AND p.month>? AND p.status='ready' AND p.active_build_id IS NOT NULL AND p.source_generation=p.applied_generation AND p.build_generation=p.source_generation
      AND s.group_id=? AND s.lease_owner=? AND s.status='backfilling' AND s.discovery_complete=1 AND s.lease_until_ms>?
      AND NOT EXISTS (SELECT 1 FROM ledger_period_state earlier WHERE earlier.group_id=p.group_id AND earlier.month>? AND earlier.month<p.month AND (earlier.status<>'ready' OR earlier.source_generation<>earlier.applied_generation OR earlier.active_build_id IS NULL))
    ORDER BY p.month LIMIT 1`).bind(groupId, through, groupId, owner, epoch(), through).first<Row>();
  if (!candidate || !hasTime(deadlineMs) || !await renewGroupLease(db, groupId, owner)) return;
  const month = text(candidate.month), sourceGeneration = number(candidate.source_generation), appliedGeneration = number(candidate.applied_generation), buildGeneration = number(candidate.build_generation), buildId = text(candidate.active_build_id), expectedCheckpoint = candidate.checkpoint_through == null ? null : text(candidate.checkpoint_through);
  const guard = `EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.status='backfilling' AND s.discovery_complete=1 AND s.checkpoint_through IS ? AND s.lease_until_ms>?)
    AND EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND p.month=? AND p.status='ready' AND p.source_generation=? AND p.applied_generation=? AND p.build_generation=? AND p.active_build_id=? AND p.lease_owner IS NULL)`;
  const args = [groupId, owner, expectedCheckpoint, epoch(), groupId, month, sourceGeneration, appliedGeneration, buildGeneration, buildId];
  await db.batch([
    db.prepare(`INSERT INTO ledger_checkpoint_balances(group_id,currency,person_id,net_minor,updated_at) SELECT group_id,currency,person_id,net_minor,? FROM ledger_period_balances WHERE group_id=? AND month=? AND build_id=? AND ${guard} ON CONFLICT(group_id,currency,person_id) DO UPDATE SET net_minor=ledger_checkpoint_balances.net_minor+excluded.net_minor,updated_at=excluded.updated_at`).bind(now(), groupId, month, buildId, ...args),
    db.prepare(`INSERT INTO ledger_checkpoint_totals(group_id,currency,gross_minor,updated_at) SELECT group_id,currency,gross_minor,? FROM ledger_period_totals WHERE group_id=? AND month=? AND build_id=? AND ${guard} ON CONFLICT(group_id,currency) DO UPDATE SET gross_minor=ledger_checkpoint_totals.gross_minor+excluded.gross_minor,updated_at=excluded.updated_at`).bind(now(), groupId, month, buildId, ...args),
    db.prepare(`UPDATE ledger_summary_state SET checkpoint_through=?,updated_at=? WHERE group_id=? AND lease_owner=? AND status='backfilling' AND discovery_complete=1 AND checkpoint_through IS ? AND lease_until_ms>? AND EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND p.month=? AND p.status='ready' AND p.source_generation=? AND p.applied_generation=? AND p.build_generation=? AND p.active_build_id=? AND p.lease_owner IS NULL)`).bind(month, now(), groupId, owner, expectedCheckpoint, epoch(), groupId, month, sourceGeneration, appliedGeneration, buildGeneration, buildId),
  ]);
}

async function scheduleSummaryAvailability(db: D1Database, groupId: string, owner: string) {
  const at = epoch();
  await db.prepare(`UPDATE ledger_summary_state SET available_at_ms=CASE WHEN EXISTS (
      SELECT 1 FROM ledger_period_state p WHERE p.group_id=ledger_summary_state.group_id
        AND (p.status<>'ready' OR p.source_generation<>p.applied_generation OR p.active_build_id IS NULL)
        AND (p.retry_at_ms IS NULL OR p.retry_at_ms<=?)
    ) OR EXISTS (
      SELECT 1 FROM ledger_period_state p WHERE p.group_id=ledger_summary_state.group_id
        AND p.status='ready' AND p.source_generation=p.applied_generation
        AND p.build_generation=p.source_generation AND p.active_build_id IS NOT NULL
        AND p.month>COALESCE(ledger_summary_state.checkpoint_through,'0000-00-00')
    ) THEN ? ELSE COALESCE((SELECT MIN(p.retry_at_ms) FROM ledger_period_state p WHERE p.group_id=ledger_summary_state.group_id
      AND (p.status<>'ready' OR p.source_generation<>p.applied_generation OR p.active_build_id IS NULL)
      AND p.retry_at_ms>?),?) END,updated_at=?
    WHERE group_id=? AND lease_owner=? AND maintenance_due=1`).bind(at, at, at, at, now(), groupId, owner).run();
}

async function yieldGroupLease(db: D1Database, groupId: string, owner: string) {
  const state = await db.prepare(`SELECT checkpoint_through FROM ledger_summary_state WHERE group_id=? AND lease_owner=? AND status='backfilling' AND lease_until_ms>?`).bind(groupId, owner, epoch()).first<Row>();
  if (!state) return false;
  const checkpoint = state.checkpoint_through == null ? null : text(state.checkpoint_through);
  const result = await db.prepare(`UPDATE ledger_summary_state SET status='backfilling',maintenance_due=1,lease_owner=NULL,lease_until_ms=NULL,updated_at=?
    WHERE group_id=? AND lease_owner=? AND status='backfilling' AND checkpoint_through IS ? AND lease_until_ms>?`).bind(now(), groupId, owner, checkpoint, epoch()).run();
  return changed(result, 0) > 0;
}

async function publish(db: D1Database, groupId: string, owner: string, deadlineMs?: number) {
  if (!hasTime(deadlineMs) || !await renewGroupLease(db, groupId, owner)) return false;
  const ready = await db.prepare(`SELECT 1 FROM ledger_summary_state state WHERE state.group_id=? AND state.lease_owner=? AND state.lease_until_ms>?
    AND state.status='backfilling' AND state.discovery_complete=1
    AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=state.group_id AND (p.status<>'ready' OR p.source_generation<>p.applied_generation OR p.active_build_id IS NULL))
    AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=state.group_id AND p.month>COALESCE(state.checkpoint_through,'0000-00-00')
      AND p.status='ready' AND p.source_generation=p.applied_generation AND p.build_generation=p.source_generation AND p.active_build_id IS NOT NULL)`).bind(groupId, owner, epoch()).first<Row>();
  if (!ready || !hasTime(deadlineMs)) return false;
  const publishGuard = `EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.status='backfilling' AND s.discovery_complete=1 AND s.lease_until_ms>?)
    AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND (p.status<>'ready' OR p.source_generation<>p.applied_generation OR p.active_build_id IS NULL))
    AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND p.month>COALESCE((SELECT current.checkpoint_through FROM ledger_summary_state current WHERE current.group_id=p.group_id AND current.lease_owner=? AND current.status='backfilling'),'0000-00-00')
      AND p.status='ready' AND p.source_generation=p.applied_generation AND p.build_generation=p.source_generation AND p.active_build_id IS NOT NULL)`;
  const guardArgs = [groupId, owner, epoch(), groupId, groupId, owner];
  const publishedAt = now(), publishedQueueTime = epoch();
  await db.batch([
    db.prepare(`DELETE FROM ledger_totals WHERE group_id=? AND ${publishGuard}`).bind(groupId, ...guardArgs),
    db.prepare(`INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at) SELECT group_id,currency,SUM(gross_minor),? FROM (
      SELECT checkpoint.group_id,checkpoint.currency,checkpoint.gross_minor FROM ledger_checkpoint_totals checkpoint WHERE checkpoint.group_id=?
      UNION ALL SELECT period_total.group_id,period_total.currency,period_total.gross_minor FROM ledger_period_totals period_total JOIN ledger_period_state period ON period.group_id=period_total.group_id AND period.month=period_total.month AND period.active_build_id=period_total.build_id JOIN ledger_summary_state state ON state.group_id=period.group_id WHERE period_total.group_id=? AND (state.checkpoint_through IS NULL OR period_total.month>state.checkpoint_through)
    ) compact WHERE ${publishGuard} GROUP BY group_id,currency`).bind(publishedAt, groupId, groupId, ...guardArgs),
    db.prepare(`UPDATE ledger_summary_state AS state SET status='ready',maintenance_due=0,available_at_ms=?,retry_count=0,last_error=NULL,updated_at=? WHERE state.group_id=? AND state.lease_owner=? AND state.status='backfilling' AND state.discovery_complete=1 AND state.lease_until_ms>?
      AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=state.group_id AND (p.status<>'ready' OR p.source_generation<>p.applied_generation OR p.active_build_id IS NULL))
      AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=state.group_id AND p.month>COALESCE(state.checkpoint_through,'0000-00-00') AND p.status='ready' AND p.source_generation=p.applied_generation AND p.build_generation=p.source_generation AND p.active_build_id IS NOT NULL)`).bind(publishedQueueTime, publishedAt, groupId, owner, epoch()),
  ]);
  // Do not rely on local Wrangler's batch changes metadata: the guarded
  // pointer and summary state are the authoritative publication result.
  const published = await db.prepare('SELECT status,maintenance_due FROM ledger_summary_state WHERE group_id=?').bind(groupId).first<Row>();
  return text(published?.status) === 'ready' && number(published?.maintenance_due) === 0;
}
