import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

/**
 * This is a maintenance hint, not a ledger boundary. Reconciliation always
 * rebuilds one complete group in one D1 batch.
 */
export const PROJECTION_RECONCILIATION_THRESHOLD = 750;

/** Read the projection when ready and retain the authoritative fallback while
 * a group is pending or stale. */
export const groupSelect = (requestedGroup = false) => `WITH authorized_groups AS (
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

const now = () => new Date().toISOString();

/** Build a complete group rebuild. Callers decide the surrounding atomic unit. */
export function projectionStatements(db: D1Database, groupId: string, timestamp = now(), finalize = false): D1PreparedStatement[] {
  const readiness = finalize
    ? db.prepare(`INSERT INTO projection_state(group_id,status,backfill_cursor,last_rebuilt_at,updated_at,mutation_count,last_reconciled_at,reconciliation_due,ledger_totals_ready)
        VALUES(?,'ready',NULL,?,?,0,?,0,1) ON CONFLICT(group_id) DO UPDATE SET status='ready',backfill_cursor=NULL,last_rebuilt_at=excluded.last_rebuilt_at,updated_at=excluded.updated_at,mutation_count=0,last_reconciled_at=excluded.last_reconciled_at,reconciliation_due=0,ledger_totals_ready=1`).bind(groupId, timestamp, timestamp, timestamp)
    : db.prepare(`INSERT INTO projection_state(group_id,status,backfill_cursor,last_rebuilt_at,updated_at,ledger_totals_ready)
         VALUES(?,'pending',NULL,NULL,?,0) ON CONFLICT(group_id) DO UPDATE SET updated_at=excluded.updated_at,ledger_totals_ready=0`).bind(groupId, timestamp);
  return [
    db.prepare('DELETE FROM ledger_totals WHERE group_id=?').bind(groupId),
    db.prepare('DELETE FROM group_balance_projection WHERE group_id=?').bind(groupId),
    db.prepare(`INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at)
      SELECT group_id,currency,SUM(amount_minor),? FROM (
        SELECT group_id,currency,amount_minor FROM expenses WHERE group_id=? AND deleted_at IS NULL
        UNION ALL SELECT group_id,currency,amount_minor FROM settlements WHERE group_id=? AND deleted_at IS NULL
      ) GROUP BY group_id,currency`).bind(timestamp, groupId, groupId),
    db.prepare(`INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at)
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

/** Apply one raw expense contribution to a ready projection. */
export function expenseProjectionDelta(db: D1Database, expenseId: string, sign: 1 | -1, timestamp: string): D1PreparedStatement[] {
  const contribution = (table: 'payers' | 'splits', multiplier: 1 | -1) => db.prepare(`
    INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at)
    SELECT e.group_id,e.currency,child.person_id,?*child.amount_minor,?
    FROM expenses e JOIN ${table} child ON child.expense_id=e.id
    WHERE e.id=? AND e.deleted_at IS NULL AND EXISTS (
      SELECT 1 FROM projection_state state WHERE state.group_id=e.group_id AND state.status='ready'
    )
    ON CONFLICT(group_id,currency,person_id) DO UPDATE SET
      net_minor=group_balance_projection.net_minor+excluded.net_minor,
      updated_at=excluded.updated_at`).bind(sign * multiplier, timestamp, expenseId);
  return [
    contribution('payers', 1),
    contribution('splits', -1),
    db.prepare(`DELETE FROM group_balance_projection WHERE group_id=(SELECT group_id FROM expenses WHERE id=?) AND net_minor=0 AND EXISTS (
      SELECT 1 FROM projection_state state WHERE state.group_id=group_balance_projection.group_id AND state.status='ready'
    )`).bind(expenseId),
  ];
}

export function settlementProjectionDelta(db: D1Database, settlementId: string, sign: 1 | -1, timestamp: string): D1PreparedStatement[] {
  const contribution = (person: 'from_person_id' | 'to_person_id', multiplier: 1 | -1) => db.prepare(`
    INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at)
    SELECT s.group_id,s.currency,s.${person},?*s.amount_minor,?
    FROM settlements s
    WHERE s.id=? AND s.deleted_at IS NULL AND EXISTS (
      SELECT 1 FROM projection_state state WHERE state.group_id=s.group_id AND state.status='ready'
    )
    ON CONFLICT(group_id,currency,person_id) DO UPDATE SET
      net_minor=group_balance_projection.net_minor+excluded.net_minor,
      updated_at=excluded.updated_at`).bind(sign * multiplier, timestamp, settlementId);
  return [
    contribution('from_person_id', 1),
    contribution('to_person_id', -1),
    db.prepare(`DELETE FROM group_balance_projection WHERE group_id=(SELECT group_id FROM settlements WHERE id=?) AND net_minor=0 AND EXISTS (
      SELECT 1 FROM projection_state state WHERE state.group_id=group_balance_projection.group_id AND state.status='ready'
    )`).bind(settlementId),
  ];
}

export function projectionRevisionGuard(revisionId: string, entityType: 'expense' | 'settlement', entityId: string) {
  return { sql: 'EXISTS (SELECT 1 FROM revisions projection_revision WHERE projection_revision.id=? AND projection_revision.entity_type=? AND projection_revision.entity_id=?)', args: [revisionId, entityType, entityId] };
}

export function boundExpenseProjectionDelta(db: D1Database, expenseId: string, groupId: string, currencyValue: string, payers: Array<{ personId: string; amountMinor: number }>, splits: Array<{ personId: string; amountMinor: number }>, sign: 1 | -1, timestamp: string, revisionId: string): D1PreparedStatement[] {
  const guard = projectionRevisionGuard(revisionId, 'expense', expenseId);
  const values = JSON.stringify([
    ...payers.map((payer) => ({ person_id: payer.personId, amount_minor: sign * payer.amountMinor })),
    ...splits.map((split) => ({ person_id: split.personId, amount_minor: sign * -split.amountMinor })),
  ]);
  return [
    db.prepare(`INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at)
      SELECT ?,?,json_extract(value,'$.person_id'),SUM(json_extract(value,'$.amount_minor')),?
      FROM json_each(?)
      WHERE EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=? AND state.status='ready') AND ${guard.sql}
      GROUP BY json_extract(value,'$.person_id')
      ON CONFLICT(group_id,currency,person_id) DO UPDATE SET net_minor=group_balance_projection.net_minor+excluded.net_minor,updated_at=excluded.updated_at`).bind(groupId, currencyValue, timestamp, values, groupId, ...guard.args),
    db.prepare(`DELETE FROM group_balance_projection WHERE group_id=? AND net_minor=0 AND EXISTS (
      SELECT 1 FROM projection_state state WHERE state.group_id=group_balance_projection.group_id AND state.status='ready'
    ) AND ${guard.sql}`).bind(groupId, ...guard.args),
  ];
}

export function boundSettlementProjectionDelta(db: D1Database, settlementId: string, groupId: string, currencyValue: string, fromPersonId: string, toPersonId: string, amountMinor: number, sign: 1 | -1, timestamp: string, revisionId: string): D1PreparedStatement[] {
  const guard = projectionRevisionGuard(revisionId, 'settlement', settlementId);
  return [
    db.prepare(`INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=? AND state.status='ready') AND ${guard.sql}
      ON CONFLICT(group_id,currency,person_id) DO UPDATE SET net_minor=group_balance_projection.net_minor+excluded.net_minor,updated_at=excluded.updated_at`).bind(groupId, currencyValue, fromPersonId, sign * amountMinor, timestamp, groupId, ...guard.args),
    db.prepare(`INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=? AND state.status='ready') AND ${guard.sql}
      ON CONFLICT(group_id,currency,person_id) DO UPDATE SET net_minor=group_balance_projection.net_minor+excluded.net_minor,updated_at=excluded.updated_at`).bind(groupId, currencyValue, toPersonId, sign * -amountMinor, timestamp, groupId, ...guard.args),
    db.prepare(`DELETE FROM group_balance_projection WHERE group_id=? AND net_minor=0 AND EXISTS (
      SELECT 1 FROM projection_state state WHERE state.group_id=group_balance_projection.group_id AND state.status='ready'
    ) AND ${guard.sql}`).bind(groupId, ...guard.args),
  ];
}

export function projectionMutation(db: D1Database, groupId: string, timestamp: string, entity: 'expenses' | 'settlements', id: string, revisionId?: string) {
  const guard = revisionId ? projectionRevisionGuard(revisionId, entity === 'expenses' ? 'expense' : 'settlement', id) : { sql: `EXISTS (SELECT 1 FROM ${entity} changed_entity WHERE changed_entity.id=?)`, args: [id] };
  return db.prepare(`UPDATE projection_state SET mutation_count=mutation_count+1,
    reconciliation_due=CASE WHEN mutation_count+1>=? THEN 1 ELSE reconciliation_due END,
    updated_at=? WHERE group_id=? AND status='ready' AND ${guard.sql}`).bind(PROJECTION_RECONCILIATION_THRESHOLD, timestamp, groupId, ...guard.args);
}

export const balanceProjectionQuery = (ready: boolean) => ready
  ? { sql: 'SELECT currency,person_id,net_minor FROM group_balance_projection WHERE group_id=? ORDER BY currency,person_id', args: 1 }
  : { sql: `SELECT currency,person_id,SUM(net_minor) AS net_minor FROM (
      SELECT e.currency,p.person_id,p.amount_minor AS net_minor FROM expenses e JOIN payers p ON p.expense_id=e.id WHERE e.group_id=? AND e.deleted_at IS NULL
      UNION ALL SELECT e.currency,s.person_id,-s.amount_minor FROM expenses e JOIN splits s ON s.expense_id=e.id WHERE e.group_id=? AND e.deleted_at IS NULL
      UNION ALL SELECT currency,from_person_id,amount_minor FROM settlements WHERE group_id=? AND deleted_at IS NULL
      UNION ALL SELECT currency,to_person_id,-amount_minor FROM settlements WHERE group_id=? AND deleted_at IS NULL
    ) GROUP BY currency,person_id HAVING SUM(net_minor)<>0 ORDER BY currency,person_id`, args: 4 };
