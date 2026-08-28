import type { D1Database } from '@cloudflare/workers-types';

type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? '');
const number = (value: unknown) => Number(value ?? 0);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
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

type Options = { maxGroups?: number; maxMonths?: number; chunkSize?: number };

export async function monthlySummaryMaintenance(db: D1Database, options: Options = {}) {
  const maxGroups = Math.min(Math.max(options.maxGroups ?? 2, 1), 10);
  const maxMonths = Math.min(Math.max(options.maxMonths ?? 4, 1), 12);
  const chunkSize = Math.min(Math.max(options.chunkSize ?? 100, 1), 100);
  const groups = (await db.prepare(`SELECT state.group_id FROM ledger_summary_state state JOIN groups g ON g.id=state.group_id
    WHERE g.deleted_at IS NULL AND state.maintenance_due=1
      AND (state.next_attempt_at IS NULL OR datetime(state.next_attempt_at)<=CURRENT_TIMESTAMP)
      AND (state.lease_until IS NULL OR datetime(state.lease_until)<=CURRENT_TIMESTAMP)
    ORDER BY state.updated_at,state.group_id LIMIT ?`).bind(maxGroups).all<Row>()).results;
  let monthsScanned = 0, monthsVerified = 0, chunks = 0, groupsFailed = 0, monthsFailed = 0;
  for (const row of groups) {
    const groupId = text(row.group_id), owner = id(), acquired = await acquireGroupLease(db, groupId, owner);
    if (!acquired) continue;
    try {
      await discoverMonths(db, groupId, owner, chunkSize);
      const months = (await db.prepare(`SELECT month FROM ledger_period_state
        WHERE group_id=? AND (status<>'ready' OR source_generation<>applied_generation OR active_build_id IS NULL)
        ORDER BY month LIMIT ?`).bind(groupId, maxMonths).all<Row>()).results;
      for (const monthRow of months) {
        if (monthsScanned >= maxGroups * maxMonths) break;
        const month = text(monthRow.month); monthsScanned += 1;
        try {
          const result = await maintainMonth(db, groupId, month, owner, chunkSize);
          chunks += result.chunks;
          if (result.verified) monthsVerified += 1;
        } catch (error) {
          monthsFailed += 1;
          const retry = new Date(Date.now() + 60_000).toISOString();
          await db.batch([
            db.prepare(`UPDATE ledger_period_state SET status='failed',retry_count=retry_count+1,next_attempt_at=?,last_error=?,updated_at=?
              WHERE group_id=? AND month=? AND lease_owner=? AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=?)`)
              .bind(retry, error instanceof Error ? error.message.slice(0, 500) : 'month maintenance failed', now(), groupId, month, owner, groupId, owner),
            db.prepare('UPDATE ledger_summary_state SET maintenance_due=1,next_attempt_at=?,updated_at=? WHERE group_id=? AND lease_owner=?').bind(retry, now(), groupId, owner),
          ]);
        }
      }
      await foldOneMonth(db, groupId, owner);
      const published = await publish(db, groupId, owner);
      if (!published) await yieldGroupLease(db, groupId, owner);
    } catch (error) {
      groupsFailed += 1;
      await db.prepare(`UPDATE ledger_summary_state SET status='failed',maintenance_due=1,retry_count=retry_count+1,next_attempt_at=?,last_error=?,updated_at=? WHERE group_id=? AND lease_owner=?`)
        .bind(new Date(Date.now() + 60_000).toISOString(), error instanceof Error ? error.message.slice(0, 500) : 'summary maintenance failed', now(), groupId, owner).run();
    } finally {
      await db.prepare('UPDATE ledger_summary_state SET lease_owner=NULL,lease_until=NULL WHERE group_id=? AND lease_owner=?').bind(groupId, owner).run();
    }
  }
  return { groupsScanned: groups.length, monthsScanned, monthsVerified, chunks, groupsFailed, monthsFailed, capped: groups.length >= maxGroups || monthsScanned >= maxGroups * maxMonths };
}

async function acquireGroupLease(db: D1Database, groupId: string, owner: string) {
  const until = new Date(Date.now() + 60_000).toISOString();
  const result = await db.prepare(`UPDATE ledger_summary_state SET status='backfilling',maintenance_due=1,lease_owner=?,lease_until=?,updated_at=?
    WHERE group_id=? AND (lease_owner IS NULL OR lease_until IS NULL OR datetime(lease_until)<=CURRENT_TIMESTAMP)`).bind(owner, until, now(), groupId).run();
  if (changed(result) > 0) return true;
  const current = await db.prepare('SELECT lease_owner FROM ledger_summary_state WHERE group_id=?').bind(groupId).first<Row>();
  return text(current?.lease_owner) === owner;
}

async function discoverMonths(db: D1Database, groupId: string, owner: string, chunkSize: number) {
  // Immutable-ID discovery has its own (group_id,id) index. The high-water
  // query intentionally uses ORDER BY/LIMIT rather than MAX(id), whose plan
  // does not match that keyset index. Rows written after the high water are
  // covered by their marker/dirty trigger and force another generation.
  await db.prepare(`UPDATE ledger_summary_state SET
      expense_discovery_high_water=COALESCE(expense_discovery_high_water,(SELECT id FROM expenses WHERE group_id=? ORDER BY id DESC LIMIT 1)),
      settlement_discovery_high_water=COALESCE(settlement_discovery_high_water,(SELECT id FROM settlements WHERE group_id=? ORDER BY id DESC LIMIT 1)),
      updated_at=? WHERE group_id=? AND lease_owner=? AND datetime(lease_until)>CURRENT_TIMESTAMP`)
    .bind(groupId, groupId, now(), groupId, owner).run();
  const state = await db.prepare('SELECT * FROM ledger_summary_state WHERE group_id=? AND lease_owner=?').bind(groupId, owner).first<Row>();
  if (!state) return false;
  const discover = async (table: 'expenses' | 'settlements', dateColumn: 'expense_date' | 'settlement_date', cursorColumn: string, highColumn: string) => {
    const cursor = state[cursorColumn] == null ? '' : text(state[cursorColumn]);
    const high = state[highColumn] == null ? null : text(state[highColumn]);
    if (high === null || cursor === high) return true;
    const rows = (await db.prepare(`SELECT id,${dateColumn} AS transaction_date FROM ${table}
      WHERE group_id=? AND id>? AND id<=? ORDER BY id LIMIT ?`).bind(groupId, cursor, high, chunkSize).all<Row>()).results;
    if (rows.length) {
      const months = JSON.stringify(rows.map((row) => ({ month: `${text(row.transaction_date).slice(0, 7)}-01` })));
      const last = text(rows[rows.length - 1].id);
      const result = await db.batch([
        db.prepare(`INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
          SELECT ?,json_extract(value,'$.month'),'pending',0,? FROM json_each(?)
          WHERE EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND datetime(s.lease_until)>CURRENT_TIMESTAMP)
          ON CONFLICT(group_id,month) DO NOTHING`).bind(groupId, now(), months, groupId, owner),
        db.prepare(`UPDATE ledger_summary_state SET ${cursorColumn}=? WHERE group_id=? AND lease_owner=? AND ${cursorColumn} IS ? AND ${highColumn} IS ? AND datetime(lease_until)>CURRENT_TIMESTAMP`)
          .bind(last, groupId, owner, state[cursorColumn] == null ? null : text(state[cursorColumn]), high),
      ]);
      if (changed(result[1], 0) === 0) return false;
      state[cursorColumn] = last;
      return false;
    }
    const result = await db.prepare(`UPDATE ledger_summary_state SET ${cursorColumn}=? WHERE group_id=? AND lease_owner=? AND ${cursorColumn} IS ? AND ${highColumn} IS ? AND datetime(lease_until)>CURRENT_TIMESTAMP`)
      .bind(high, groupId, owner, state[cursorColumn] == null ? null : text(state[cursorColumn]), high).run();
    if (changed(result, 0) === 0) return false;
    state[cursorColumn] = high;
    return true;
  };
  const expensesDone = await discover('expenses', 'expense_date', 'expense_discovery_cursor', 'expense_discovery_high_water');
  const settlementsDone = await discover('settlements', 'settlement_date', 'settlement_discovery_cursor', 'settlement_discovery_high_water');
  if (!expensesDone || !settlementsDone) return false;
  const completed = await db.prepare(`UPDATE ledger_summary_state SET discovery_complete=1,maintenance_due=1,updated_at=?
    WHERE group_id=? AND lease_owner=? AND datetime(lease_until)>CURRENT_TIMESTAMP
      AND (expense_discovery_high_water IS NULL OR expense_discovery_cursor IS expense_discovery_high_water)
      AND (settlement_discovery_high_water IS NULL OR settlement_discovery_cursor IS settlement_discovery_high_water)`)
    .bind(now(), groupId, owner).run();
  return changed(completed, 0) > 0;
}

async function maintainMonth(db: D1Database, groupId: string, month: string, owner: string, chunkSize: number) {
  let state = await db.prepare('SELECT p.*,s.checkpoint_through FROM ledger_period_state p JOIN ledger_summary_state s ON s.group_id=p.group_id WHERE p.group_id=? AND p.month=?').bind(groupId, month).first<Row>();
  if (!state) return { chunks: 0, verified: false };
  if (text(state.status) === 'ready' && number(state.source_generation) === number(state.applied_generation) && state.active_build_id != null) return { chunks: 0, verified: false };
  const source = number(state.source_generation), until = new Date(Date.now() + 60_000).toISOString(), newBuild = id();
  const reset = text(state.status) !== 'backfilling' || number(state.build_generation) !== source || state.build_id == null;
  const build = reset ? newBuild : text(state.build_id);
  if (reset) {
    const expenseHigh = (await db.prepare(`SELECT expense_date AS date,id FROM expenses WHERE group_id=? AND expense_date>=? AND expense_date<? ORDER BY expense_date DESC,id DESC LIMIT 1`).bind(groupId, month, nextMonth(month)).first<Row>());
    const settlementHigh = (await db.prepare(`SELECT settlement_date AS date,id FROM settlements WHERE group_id=? AND settlement_date>=? AND settlement_date<? ORDER BY settlement_date DESC,id DESC LIMIT 1`).bind(groupId, month, nextMonth(month)).first<Row>());
    const result = await db.prepare(`UPDATE ledger_period_state SET status='backfilling',build_generation=source_generation,build_id=?,
        expense_cursor=NULL,settlement_cursor=NULL,expense_high_water=?,settlement_high_water=?,lease_owner=?,lease_until=?,last_error=NULL,updated_at=?
      WHERE group_id=? AND month=? AND source_generation=? AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND datetime(s.lease_until)>CURRENT_TIMESTAMP)`)
      .bind(build, expenseHigh ? encodeKey(text(expenseHigh.date), text(expenseHigh.id)) : null, settlementHigh ? encodeKey(text(settlementHigh.date), text(settlementHigh.id)) : null, owner, until, now(), groupId, month, source, groupId, owner).run();
    // D1 implementations differ in whether a no-op UPDATE exposes changes;
    // the guarded state read below is the authoritative lease check.
  } else {
    const takeover = await db.prepare(`UPDATE ledger_period_state SET lease_owner=?,lease_until=?,updated_at=?
      WHERE group_id=? AND month=? AND status='backfilling' AND build_id=? AND build_generation=? AND source_generation=?
        AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND datetime(s.lease_until)>CURRENT_TIMESTAMP)`)
      .bind(owner, until, now(), groupId, month, build, source, source, groupId, owner).run();
    // The following state read, rather than driver-specific changes metadata,
    // decides whether this worker actually owns the period lease.
  }
  const current = await db.prepare('SELECT p.*,s.checkpoint_through FROM ledger_period_state p JOIN ledger_summary_state s ON s.group_id=p.group_id WHERE p.group_id=? AND p.month=?').bind(groupId, month).first<Row>();
  if (!current || text(current.build_id) !== build || text(current.lease_owner) !== owner) return { chunks: 0, verified: false };
  const buildGeneration = number(current.build_generation), sourceGeneration = number(current.source_generation), expectedCheckpoint = current.checkpoint_through == null ? null : text(current.checkpoint_through);
  let expenseCursor = decodeKey(current.expense_cursor), settlementCursor = decodeKey(current.settlement_cursor);
  const expenseHigh = decodeKey(current.expense_high_water), settlementHigh = decodeKey(current.settlement_high_water);
  const guard = (expenseExpected: string | null, settlementExpected: string | null) => ({
    sql: `EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND datetime(s.lease_until)>CURRENT_TIMESTAMP)
      AND EXISTS (SELECT 1 FROM ledger_summary_state s2 WHERE s2.group_id=? AND s2.lease_owner=? AND s2.checkpoint_through IS ? AND s2.status='backfilling' AND datetime(s2.lease_until)>CURRENT_TIMESTAMP)
      AND EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND p.month=? AND p.status='backfilling' AND p.lease_owner=? AND p.build_id=? AND p.build_generation=? AND p.source_generation=? AND p.expense_cursor IS ? AND p.settlement_cursor IS ? AND datetime(p.lease_until)>CURRENT_TIMESTAMP)`,
    args: [groupId, owner, groupId, owner, expectedCheckpoint, groupId, month, owner, build, buildGeneration, sourceGeneration, expenseExpected, settlementExpected],
  });
  let count = 0;
  const readChunk = async (table: 'expenses' | 'settlements', dateColumn: 'expense_date' | 'settlement_date', cursor: { date: string; id: string } | null, high: { date: string; id: string } | null) => {
    if (!high || sameKey(cursor, high)) return [] as Row[];
    const after = cursor ? `((${dateColumn}>?) OR (${dateColumn}=? AND id>?))` : '1=1';
    const before = `(${dateColumn}<? OR (${dateColumn}=? AND id<=?))`;
    const args: unknown[] = [groupId, month, nextMonth(month)];
    if (cursor) args.push(cursor.date, cursor.date, cursor.id);
    args.push(high.date, high.date, high.id, chunkSize);
    const result = (await db.prepare(`SELECT id,${dateColumn} AS transaction_date FROM ${table}
      WHERE group_id=? AND ${dateColumn}>=? AND ${dateColumn}<? AND ${after} AND ${before}
      ORDER BY ${dateColumn},id LIMIT ?`).bind(...args).all<Row>()).results;
    return result;
  };
  const expenseRows = await readChunk('expenses', 'expense_date', expenseCursor, expenseHigh);
  if (expenseRows.length) {
    const ids = expenseRows.map((value) => text(value.id)), last = { date: text(expenseRows[expenseRows.length - 1].transaction_date), id: ids[ids.length - 1] }, g = guard(current.expense_cursor == null ? null : text(current.expense_cursor), current.settlement_cursor == null ? null : text(current.settlement_cursor)), encoded = JSON.stringify(ids);
    await db.batch([
      db.prepare(`INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT e.group_id,?, ?,e.currency,p.person_id,SUM(p.amount_minor),? FROM expenses e JOIN payers p ON p.expense_id=e.id WHERE e.id IN (SELECT value FROM json_each(?)) AND e.deleted_at IS NULL AND ${g.sql} GROUP BY e.group_id,e.currency,p.person_id ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT e.group_id,?, ?,e.currency,s.person_id,-SUM(s.amount_minor),? FROM expenses e JOIN splits s ON s.expense_id=e.id WHERE e.id IN (SELECT value FROM json_each(?)) AND e.deleted_at IS NULL AND ${g.sql} GROUP BY e.group_id,e.currency,s.person_id ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`INSERT INTO ledger_period_totals(group_id,month,build_id,currency,gross_minor,updated_at) SELECT group_id,?, ?,currency,SUM(amount_minor),? FROM expenses WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND ${g.sql} GROUP BY group_id,currency ON CONFLICT(group_id,month,build_id,currency) DO UPDATE SET gross_minor=ledger_period_totals.gross_minor+excluded.gross_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`UPDATE ledger_period_state SET expense_cursor=?,updated_at=? WHERE group_id=? AND month=? AND expense_cursor IS ? AND ${g.sql}`).bind(encodeKey(last.date, last.id), now(), groupId, month, current.expense_cursor == null ? null : text(current.expense_cursor), ...g.args),
    ]);
    expenseCursor = last; current.expense_cursor = encodeKey(last.date, last.id); count += 1;
  } else if (expenseHigh && !sameKey(expenseCursor, expenseHigh)) {
    const g = guard(current.expense_cursor == null ? null : text(current.expense_cursor), current.settlement_cursor == null ? null : text(current.settlement_cursor));
    const result = await db.prepare(`UPDATE ledger_period_state SET expense_cursor=? WHERE group_id=? AND month=? AND expense_cursor IS ? AND ${g.sql}`).bind(encodeKey(expenseHigh.date, expenseHigh.id), groupId, month, current.expense_cursor == null ? null : text(current.expense_cursor), ...g.args).run();
    if (changed(result, 0) === 0) return { chunks: count, verified: false }; expenseCursor = expenseHigh; current.expense_cursor = encodeKey(expenseHigh.date, expenseHigh.id);
  }
  const settlementRows = await readChunk('settlements', 'settlement_date', settlementCursor, settlementHigh);
  if (settlementRows.length) {
    const ids = settlementRows.map((value) => text(value.id)), last = { date: text(settlementRows[settlementRows.length - 1].transaction_date), id: ids[ids.length - 1] }, g = guard(current.expense_cursor == null ? null : text(current.expense_cursor), current.settlement_cursor == null ? null : text(current.settlement_cursor)), encoded = JSON.stringify(ids);
    await db.batch([
      db.prepare(`INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT group_id,?, ?,currency,from_person_id,SUM(amount_minor),? FROM settlements WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND ${g.sql} GROUP BY group_id,currency,from_person_id ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT group_id,?, ?,currency,to_person_id,-SUM(amount_minor),? FROM settlements WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND ${g.sql} GROUP BY group_id,currency,to_person_id ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`INSERT INTO ledger_period_totals(group_id,month,build_id,currency,gross_minor,updated_at) SELECT group_id,?, ?,currency,SUM(amount_minor),? FROM settlements WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND ${g.sql} GROUP BY group_id,currency ON CONFLICT(group_id,month,build_id,currency) DO UPDATE SET gross_minor=ledger_period_totals.gross_minor+excluded.gross_minor`).bind(month, build, now(), encoded, ...g.args),
      db.prepare(`UPDATE ledger_period_state SET settlement_cursor=?,updated_at=? WHERE group_id=? AND month=? AND settlement_cursor IS ? AND ${g.sql}`).bind(encodeKey(last.date, last.id), now(), groupId, month, current.settlement_cursor == null ? null : text(current.settlement_cursor), ...g.args),
    ]);
    settlementCursor = last; current.settlement_cursor = encodeKey(last.date, last.id); count += 1;
  } else if (settlementHigh && !sameKey(settlementCursor, settlementHigh)) {
    const g = guard(current.expense_cursor == null ? null : text(current.expense_cursor), current.settlement_cursor == null ? null : text(current.settlement_cursor));
    const result = await db.prepare(`UPDATE ledger_period_state SET settlement_cursor=? WHERE group_id=? AND month=? AND settlement_cursor IS ? AND ${g.sql}`).bind(encodeKey(settlementHigh.date, settlementHigh.id), groupId, month, current.settlement_cursor == null ? null : text(current.settlement_cursor), ...g.args).run();
    if (changed(result, 0) === 0) return { chunks: count, verified: false }; settlementCursor = settlementHigh; current.settlement_cursor = encodeKey(settlementHigh.date, settlementHigh.id);
  }
  if (!sameKey(expenseCursor, expenseHigh) || !sameKey(settlementCursor, settlementHigh)) return { chunks: count, verified: false };
  const expenseCursorText = expenseCursor ? encodeKey(expenseCursor.date, expenseCursor.id) : null;
  const settlementCursorText = settlementCursor ? encodeKey(settlementCursor.date, settlementCursor.id) : null;
  const g = guard(expenseCursorText, settlementCursorText);
  const result = await db.batch([
    // Correct the rolling checkpoint by verified-new minus active-old before
    // flipping the active build. This also handles old-worker corrections.
    db.prepare(`WITH deltas AS (SELECT currency,person_id,net_minor AS delta FROM ledger_period_balances WHERE group_id=? AND month=? AND build_id=?
        UNION ALL SELECT currency,person_id,-net_minor FROM ledger_period_balances old WHERE old.group_id=? AND old.month=? AND old.build_id=(SELECT active_build_id FROM ledger_period_state WHERE group_id=? AND month=?)), grouped AS (SELECT currency,person_id,SUM(delta) AS delta FROM deltas GROUP BY currency,person_id)
      UPDATE ledger_checkpoint_balances AS checkpoint SET net_minor=checkpoint.net_minor+(SELECT delta FROM grouped WHERE grouped.currency=checkpoint.currency AND grouped.person_id=checkpoint.person_id),updated_at=?
      WHERE checkpoint.group_id=? AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.checkpoint_through IS ? AND s.checkpoint_through IS NOT NULL AND s.checkpoint_through>=?) AND EXISTS (SELECT 1 FROM grouped WHERE grouped.currency=checkpoint.currency AND grouped.person_id=checkpoint.person_id AND grouped.delta<>0) AND ${g.sql}`).bind(groupId, month, build, groupId, month, groupId, month, now(), groupId, groupId, expectedCheckpoint, month, ...g.args),
    db.prepare(`WITH deltas AS (SELECT currency,person_id,net_minor AS delta FROM ledger_period_balances WHERE group_id=? AND month=? AND build_id=? UNION ALL SELECT currency,person_id,-net_minor FROM ledger_period_balances old WHERE old.group_id=? AND old.month=? AND old.build_id=(SELECT active_build_id FROM ledger_period_state WHERE group_id=? AND month=?)), grouped AS (SELECT currency,person_id,SUM(delta) AS delta FROM deltas GROUP BY currency,person_id)
      INSERT INTO ledger_checkpoint_balances(group_id,currency,person_id,net_minor,updated_at) SELECT ?,grouped.currency,grouped.person_id,grouped.delta,? FROM grouped WHERE grouped.delta<>0 AND NOT EXISTS (SELECT 1 FROM ledger_checkpoint_balances checkpoint WHERE checkpoint.group_id=? AND checkpoint.currency=grouped.currency AND checkpoint.person_id=grouped.person_id) AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.checkpoint_through IS ? AND s.checkpoint_through IS NOT NULL AND s.checkpoint_through>=?) AND ${g.sql}`).bind(groupId, month, build, groupId, month, groupId, month, groupId, now(), groupId, groupId, expectedCheckpoint, month, ...g.args),
    db.prepare(`WITH deltas AS (SELECT currency,gross_minor AS delta FROM ledger_period_totals WHERE group_id=? AND month=? AND build_id=? UNION ALL SELECT currency,-gross_minor FROM ledger_period_totals old WHERE old.group_id=? AND old.month=? AND old.build_id=(SELECT active_build_id FROM ledger_period_state WHERE group_id=? AND month=?)), grouped AS (SELECT currency,SUM(delta) AS delta FROM deltas GROUP BY currency)
       UPDATE ledger_checkpoint_totals AS checkpoint SET gross_minor=checkpoint.gross_minor+(SELECT delta FROM grouped WHERE grouped.currency=checkpoint.currency),updated_at=? WHERE checkpoint.group_id=? AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.checkpoint_through IS ? AND s.checkpoint_through IS NOT NULL AND s.checkpoint_through>=?) AND EXISTS (SELECT 1 FROM grouped WHERE grouped.currency=checkpoint.currency AND grouped.delta<>0) AND checkpoint.gross_minor+(SELECT delta FROM grouped WHERE grouped.currency=checkpoint.currency) BETWEEN 0 AND 9007199254740991 AND ${g.sql}`).bind(groupId, month, build, groupId, month, groupId, month, now(), groupId, groupId, expectedCheckpoint, month, ...g.args),
    db.prepare(`WITH deltas AS (SELECT currency,gross_minor AS delta FROM ledger_period_totals WHERE group_id=? AND month=? AND build_id=? UNION ALL SELECT currency,-gross_minor FROM ledger_period_totals old WHERE old.group_id=? AND old.month=? AND old.build_id=(SELECT active_build_id FROM ledger_period_state WHERE group_id=? AND month=?)), grouped AS (SELECT currency,SUM(delta) AS delta FROM deltas GROUP BY currency)
      INSERT INTO ledger_checkpoint_totals(group_id,currency,gross_minor,updated_at) SELECT ?,grouped.currency,grouped.delta,? FROM grouped WHERE grouped.delta<>0 AND grouped.delta>=0 AND NOT EXISTS (SELECT 1 FROM ledger_checkpoint_totals checkpoint WHERE checkpoint.group_id=? AND checkpoint.currency=grouped.currency) AND EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.checkpoint_through IS ? AND s.checkpoint_through IS NOT NULL AND s.checkpoint_through>=?) AND ${g.sql}`).bind(groupId, month, build, groupId, month, groupId, month, groupId, now(), groupId, groupId, expectedCheckpoint, month, ...g.args),
    // Bounded publication: no period delete/copy. Readers switch builds by
    // this one guarded pointer flip.
    db.prepare(`UPDATE ledger_period_state SET active_build_id=build_id,status='ready',applied_generation=build_generation,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE group_id=? AND month=? AND status='backfilling' AND build_id=? AND source_generation=build_generation AND expense_cursor IS ? AND settlement_cursor IS ? AND ${g.sql}`).bind(now(), groupId, month, build, expenseCursorText, settlementCursorText, ...g.args),
  ]);
  return { chunks: count, verified: changed(result[result.length - 1], 0) > 0 };
}

async function foldOneMonth(db: D1Database, groupId: string, owner: string) {
  const state = await db.prepare("SELECT checkpoint_through FROM ledger_summary_state WHERE group_id=? AND lease_owner=? AND status='backfilling' AND datetime(lease_until)>CURRENT_TIMESTAMP").bind(groupId, owner).first<Row>();
  if (!state) return;
  const through = state.checkpoint_through == null ? '0000-00-00' : text(state.checkpoint_through);
  const candidate = await db.prepare(`SELECT p.month,p.source_generation,p.applied_generation,p.build_generation,p.active_build_id,s.checkpoint_through
    FROM ledger_period_state p JOIN ledger_summary_state s ON s.group_id=p.group_id
    WHERE p.group_id=? AND p.month>? AND p.status='ready' AND p.active_build_id IS NOT NULL
      AND p.source_generation=p.applied_generation AND p.build_generation=p.source_generation
      AND s.group_id=? AND s.lease_owner=? AND s.status='backfilling' AND s.discovery_complete=1 AND datetime(s.lease_until)>CURRENT_TIMESTAMP
      AND NOT EXISTS (SELECT 1 FROM ledger_period_state earlier WHERE earlier.group_id=p.group_id AND earlier.month>? AND earlier.month<p.month AND (earlier.status<>'ready' OR earlier.source_generation<>earlier.applied_generation OR earlier.active_build_id IS NULL))
    ORDER BY p.month LIMIT 1`).bind(groupId, through, groupId, owner, through).first<Row>();
  if (!candidate) return;
  const month = text(candidate.month), sourceGeneration = number(candidate.source_generation), appliedGeneration = number(candidate.applied_generation), buildGeneration = number(candidate.build_generation), buildId = text(candidate.active_build_id), expectedCheckpoint = candidate.checkpoint_through == null ? null : text(candidate.checkpoint_through);
  const guard = `EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.status='backfilling' AND s.discovery_complete=1 AND s.checkpoint_through IS ? AND datetime(s.lease_until)>CURRENT_TIMESTAMP)
    AND EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND p.month=? AND p.status='ready' AND p.source_generation=? AND p.applied_generation=? AND p.build_generation=? AND p.active_build_id=? AND p.lease_owner IS NULL)`;
  await db.batch([
    db.prepare(`INSERT INTO ledger_checkpoint_balances(group_id,currency,person_id,net_minor,updated_at) SELECT group_id,currency,person_id,net_minor,? FROM ledger_period_balances WHERE group_id=? AND month=? AND build_id=? AND ${guard} ON CONFLICT(group_id,currency,person_id) DO UPDATE SET net_minor=ledger_checkpoint_balances.net_minor+excluded.net_minor,updated_at=excluded.updated_at`).bind(now(), groupId, month, buildId, groupId, owner, expectedCheckpoint, groupId, month, sourceGeneration, appliedGeneration, buildGeneration, buildId),
    db.prepare(`INSERT INTO ledger_checkpoint_totals(group_id,currency,gross_minor,updated_at) SELECT group_id,currency,gross_minor,? FROM ledger_period_totals WHERE group_id=? AND month=? AND build_id=? AND ${guard} ON CONFLICT(group_id,currency) DO UPDATE SET gross_minor=ledger_checkpoint_totals.gross_minor+excluded.gross_minor,updated_at=excluded.updated_at`).bind(now(), groupId, month, buildId, groupId, owner, expectedCheckpoint, groupId, month, sourceGeneration, appliedGeneration, buildGeneration, buildId),
    db.prepare(`UPDATE ledger_summary_state SET checkpoint_through=?,updated_at=? WHERE group_id=? AND lease_owner=? AND status='backfilling' AND discovery_complete=1 AND checkpoint_through IS ? AND datetime(lease_until)>CURRENT_TIMESTAMP AND EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND p.month=? AND p.status='ready' AND p.source_generation=? AND p.applied_generation=? AND p.build_generation=? AND p.active_build_id=? AND p.lease_owner IS NULL)`).bind(month, now(), groupId, owner, expectedCheckpoint, groupId, month, sourceGeneration, appliedGeneration, buildGeneration, buildId),
  ]);
}

/**
 * A group with another verified month still waiting to be folded must yield its
 * Cron slot rather than looking ready.  Keep the queue bit set and clear the
 * lease only if the same owner still holds the same checkpoint generation;
 * otherwise a racing mutation or takeover gets to retry from its newer state.
 */
async function yieldGroupLease(db: D1Database, groupId: string, owner: string) {
  const state = await db.prepare(`SELECT checkpoint_through FROM ledger_summary_state
    WHERE group_id=? AND lease_owner=? AND status='backfilling' AND datetime(lease_until)>CURRENT_TIMESTAMP`).bind(groupId, owner).first<Row>();
  if (!state) return false;
  const checkpoint = state.checkpoint_through == null ? null : text(state.checkpoint_through);
  const result = await db.prepare(`UPDATE ledger_summary_state SET status='backfilling',maintenance_due=1,
      lease_owner=NULL,lease_until=NULL,updated_at=?
    WHERE group_id=? AND lease_owner=? AND status='backfilling' AND checkpoint_through IS ?
      AND datetime(lease_until)>CURRENT_TIMESTAMP`).bind(now(), groupId, owner, checkpoint).run();
  return changed(result, 0) > 0;
}

async function publish(db: D1Database, groupId: string, owner: string) {
  const ready = await db.prepare(`SELECT 1 FROM ledger_summary_state state WHERE state.group_id=? AND state.lease_owner=? AND datetime(state.lease_until)>CURRENT_TIMESTAMP
    AND state.status='backfilling' AND state.discovery_complete=1
    AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=state.group_id AND (p.status<>'ready' OR p.source_generation<>p.applied_generation OR p.active_build_id IS NULL))
    AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=state.group_id
      AND p.month>COALESCE(state.checkpoint_through,'0000-00-00')
      AND p.status='ready' AND p.source_generation=p.applied_generation
      AND p.build_generation=p.source_generation AND p.active_build_id IS NOT NULL)`).bind(groupId, owner).first<Row>();
  if (!ready) return false;
  const guard = `EXISTS (SELECT 1 FROM ledger_summary_state s WHERE s.group_id=? AND s.lease_owner=? AND s.status='backfilling' AND s.discovery_complete=1 AND datetime(s.lease_until)>CURRENT_TIMESTAMP)
    AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=? AND (p.status<>'ready' OR p.source_generation<>p.applied_generation OR p.active_build_id IS NULL))
    AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=?
      AND p.month>COALESCE((SELECT current.checkpoint_through FROM ledger_summary_state current
        WHERE current.group_id=p.group_id AND current.lease_owner=? AND current.status='backfilling'),'0000-00-00')
      AND p.status='ready' AND p.source_generation=p.applied_generation
      AND p.build_generation=p.source_generation AND p.active_build_id IS NOT NULL)`;
  // Rebuild the O(1) gross guard only from the compact rolling checkpoint and
  // active post-checkpoint periods. Never aggregate every lifetime month.
  // Publication is allowed only after all eligible verified months have been
  // folded. The checkpoint makes the rebuild compact; the remaining active
  // period rows are the bounded post-checkpoint tail.
  const result = await db.batch([
    db.prepare(`DELETE FROM ledger_totals WHERE group_id=? AND ${guard}`).bind(groupId, groupId, owner, groupId, groupId, owner),
    db.prepare(`INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at)
      SELECT group_id,currency,SUM(gross_minor),? FROM (
        SELECT checkpoint.group_id,checkpoint.currency,checkpoint.gross_minor FROM ledger_checkpoint_totals checkpoint WHERE checkpoint.group_id=?
        UNION ALL
        SELECT period_total.group_id,period_total.currency,period_total.gross_minor FROM ledger_period_totals period_total
          JOIN ledger_period_state period ON period.group_id=period_total.group_id AND period.month=period_total.month AND period.active_build_id=period_total.build_id
          JOIN ledger_summary_state state ON state.group_id=period.group_id
          WHERE period_total.group_id=? AND (state.checkpoint_through IS NULL OR period_total.month>state.checkpoint_through)
        ) compact WHERE ${guard} GROUP BY group_id,currency`).bind(now(), groupId, groupId, groupId, owner, groupId, groupId, owner),
    db.prepare(`UPDATE ledger_summary_state AS state SET status='ready',maintenance_due=0,retry_count=0,next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE state.group_id=? AND state.lease_owner=? AND state.status='backfilling' AND state.discovery_complete=1 AND datetime(state.lease_until)>CURRENT_TIMESTAMP
      AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=state.group_id AND (p.status<>'ready' OR p.source_generation<>p.applied_generation OR p.active_build_id IS NULL))
      AND NOT EXISTS (SELECT 1 FROM ledger_period_state p WHERE p.group_id=state.group_id
        AND p.month>COALESCE(state.checkpoint_through,'0000-00-00')
        AND p.status='ready' AND p.source_generation=p.applied_generation
        AND p.build_generation=p.source_generation AND p.active_build_id IS NOT NULL)`).bind(now(), groupId, owner),
  ]);
  return changed(result[result.length - 1], 0) > 0;
}
