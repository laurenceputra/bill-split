import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

type Contribution = { month: string; currency: string; person_id: string; net_minor: number };
type GrossContribution = { month: string; currency: string; gross_minor: number };
type Mutation = { table: 'expenses' | 'settlements'; id: string; groupId: string; marker: string };

const now = () => new Date().toISOString();
const buildId = () => crypto.randomUUID();

/** Transaction dates, rather than write timestamps, define accounting periods. */
export const ledgerMonth = (date: string) => `${date.slice(0, 7)}-01`;

const mutationGuard = (mutation?: Mutation) => mutation
  ? { sql: `EXISTS (SELECT 1 FROM ${mutation.table} changed_entity
      WHERE changed_entity.id=? AND changed_entity.group_id=? AND changed_entity.projection_mutation_id=?)`, args: [mutation.id, mutation.groupId, mutation.marker] }
  : { sql: '0=1', args: [] as unknown[] };

const readyPredicate = (stateAlias: string) => `${stateAlias}.status='ready' AND ${stateAlias}.discovery_complete=1
  AND ${stateAlias}.maintenance_due=0
  AND NOT EXISTS (SELECT 1 FROM ledger_period_state period
    WHERE period.group_id=${stateAlias}.group_id
      AND (period.status<>'ready' OR period.source_generation<>period.applied_generation OR period.active_build_id IS NULL))`;

/**
 * The readiness predicate is intentionally expressed at the requested group
 * for balance reads. It must never materialize readiness for every tenant.
 */
/**
 * Select the source and read the balances in one statement.  In particular,
 * do not look up readiness in one request and then choose a second statement:
 * a ready -> pending transition between those requests used to return an
 * empty (or stale) projection.  The two branches below are mutually
 * exclusive against the same statement snapshot.
 */
export const balanceProjectionQuery = () => ({
  sql: `WITH requested_group AS (SELECT ? AS group_id),
    ready_group AS (
      SELECT state.group_id FROM ledger_summary_state state JOIN requested_group requested ON requested.group_id=state.group_id
      WHERE ${readyPredicate('state')}
    ),
    ready_ledger AS (
      SELECT cb.group_id,cb.currency,cb.person_id,cb.net_minor
        FROM ledger_checkpoint_balances cb JOIN ready_group ready ON ready.group_id=cb.group_id
      UNION ALL
      SELECT pb.group_id,pb.currency,pb.person_id,pb.net_minor
        FROM ledger_period_balances pb
        JOIN ledger_period_state period ON period.group_id=pb.group_id AND period.month=pb.month AND period.active_build_id=pb.build_id
        JOIN ready_group ready ON ready.group_id=pb.group_id
        JOIN ledger_summary_state state ON state.group_id=pb.group_id
        WHERE state.checkpoint_through IS NULL OR pb.month>state.checkpoint_through
    ),
    authoritative_ledger AS (
      SELECT e.group_id,e.currency,p.person_id,p.amount_minor AS net_minor
        FROM expenses e JOIN requested_group requested ON requested.group_id=e.group_id JOIN payers p ON p.expense_id=e.id
        WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ready_group)
      UNION ALL
      SELECT e.group_id,e.currency,s.person_id,-s.amount_minor
        FROM expenses e JOIN requested_group requested ON requested.group_id=e.group_id JOIN splits s ON s.expense_id=e.id
        WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ready_group)
      UNION ALL
      SELECT s.group_id,s.currency,s.from_person_id,s.amount_minor
        FROM settlements s JOIN requested_group requested ON requested.group_id=s.group_id
        WHERE s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ready_group)
      UNION ALL
      SELECT s.group_id,s.currency,s.to_person_id,-s.amount_minor
        FROM settlements s JOIN requested_group requested ON requested.group_id=s.group_id
        WHERE s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ready_group)
    ),
    ledger AS (
      SELECT group_id,currency,person_id,net_minor FROM ready_ledger
      UNION ALL
      SELECT group_id,currency,person_id,net_minor FROM authoritative_ledger
    ),
    grouped AS (
      SELECT currency,person_id,SUM(net_minor) AS net_minor FROM ledger
      GROUP BY currency,person_id HAVING SUM(net_minor)<>0
    )
    SELECT mode.ready AS read_ready,grouped.currency,grouped.person_id,grouped.net_minor
      FROM (SELECT EXISTS (SELECT 1 FROM ready_group) AS ready) mode
      LEFT JOIN grouped ON 1=1
      ORDER BY grouped.currency,grouped.person_id`,
  args: 1,
});

/**
 * Build the derived side of one authoritative mutation. Every statement is
 * guarded by the parent marker. Pending/dirty groups never receive a partial
 * delta. Ready writes update both the active period build and the rolling
 * checkpoint, so checkpointed months retain exact lifetime gross totals.
 */
export function summaryDelta(
  db: D1Database,
  groupId: string,
  contributions: Contribution[],
  gross: GrossContribution[],
  sign: 1 | -1,
  timestamp = now(),
  mutation?: Mutation,
): D1PreparedStatement[] {
  const guard = mutationGuard(mutation);
  const contributionJson = JSON.stringify(contributions.map((value) => ({ ...value, net_minor: value.net_minor * sign })));
  const grossJson = JSON.stringify(gross.map((value) => ({ ...value, gross_minor: value.gross_minor * sign })));
  const newBuild = buildId(), queueTime = Date.now();
  const guarded = (sql: string, args: unknown[]) => {
    const conflict = sql.indexOf(' ON CONFLICT');
    if (conflict < 0) return db.prepare(`${sql} AND ${guard.sql}`).bind(...args, ...guard.args);
    // CTE-backed upserts have a GROUP BY in the CTE, while their outer SELECT
    // can end directly in a WHERE. Put the guard before ON CONFLICT there;
    // ordinary INSERT ... SELECT statements put it before their GROUP BY.
    const groupBy = sql.lastIndexOf(' GROUP BY', conflict);
    const insertionPoint = sql.trimStart().startsWith('WITH') ? conflict : (groupBy >= 0 ? groupBy : conflict);
    const guardedSql = `${sql.slice(0, insertionPoint)} AND ${guard.sql}${sql.slice(insertionPoint)}`;
    return db.prepare(guardedSql).bind(...args, ...guard.args);
  };
  const readyPeriod = `EXISTS (SELECT 1 FROM ledger_summary_state summary
      WHERE summary.group_id=? AND summary.status='ready' AND summary.discovery_complete=1 AND summary.maintenance_due=0)
    AND EXISTS (SELECT 1 FROM ledger_period_state period
      WHERE period.group_id=? AND period.month=json_extract(value,'$.month')
        AND period.status='ready' AND period.source_generation=period.applied_generation
        AND period.active_build_id IS NOT NULL)`;
  const readyPeriodArgs = [groupId, groupId];
  return [
    db.prepare(`INSERT INTO ledger_summary_state(group_id,status,maintenance_due,available_at_ms,updated_at)
      SELECT ?,'pending',1,?,? WHERE ${guard.sql} ON CONFLICT(group_id) DO NOTHING`).bind(groupId, queueTime, timestamp, ...guard.args),
    // A first mutation in a period not represented by the rolling checkpoint
    // creates an unbounded ready tail if it is allowed to publish immediately.
    // Move the new summary out of ready before creating that period so reads
    // use the exact authoritative fallback until maintenance folds it.
    guarded(`UPDATE ledger_summary_state SET status='pending',maintenance_due=1,available_at_ms=?,updated_at=?
      WHERE group_id=? AND status='ready'
        AND EXISTS (SELECT 1 FROM (SELECT DISTINCT json_extract(value,'$.month') AS month FROM json_each(?)) delta
          WHERE delta.month>COALESCE(ledger_summary_state.checkpoint_through,'0000-00-00')
            AND NOT EXISTS (SELECT 1 FROM ledger_period_state period WHERE period.group_id=ledger_summary_state.group_id AND period.month=delta.month))`, [queueTime, timestamp, groupId, contributionJson]),
    guarded(`UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=?,updated_at=? WHERE group_id=? AND status='ready' AND discovery_complete=1 AND maintenance_due=0
      AND EXISTS (WITH deltas AS (SELECT json_extract(value,'$.month') month,json_extract(value,'$.currency') currency,SUM(json_extract(value,'$.gross_minor')) gross_minor FROM json_each(?) GROUP BY month,currency)
        SELECT 1 FROM deltas d JOIN ledger_period_state period ON period.group_id=? AND period.month=d.month AND period.status='ready'
        WHERE d.gross_minor<0 AND COALESCE((SELECT gross_minor FROM ledger_period_totals total
          JOIN ledger_period_state total_period ON total_period.group_id=total.group_id AND total_period.month=total.month AND total_period.active_build_id=total.build_id
           WHERE total.group_id=? AND total.month=d.month AND total.currency=d.currency),0)+d.gross_minor<0)`, [queueTime, timestamp, groupId, grossJson, groupId, groupId]),
    guarded(`INSERT INTO ledger_period_state(group_id,month,status,source_generation,applied_generation,build_generation,active_build_id,updated_at)
      SELECT ?,json_extract(value,'$.month'),CASE WHEN (SELECT status FROM ledger_summary_state WHERE group_id=?)='ready' THEN 'ready' ELSE 'pending' END,
        0,0,0,CASE WHEN (SELECT status FROM ledger_summary_state WHERE group_id=?)='ready' THEN ? ELSE NULL END,?
      FROM (SELECT DISTINCT value FROM json_each(?)) WHERE 1=1 ON CONFLICT(group_id,month) DO NOTHING`, [groupId, groupId, groupId, newBuild, timestamp, contributionJson]),
    guarded(`INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at)
      SELECT ?,json_extract(value,'$.month'),period.active_build_id,json_extract(value,'$.currency'),json_extract(value,'$.person_id'),SUM(json_extract(value,'$.net_minor')),?
      FROM json_each(?) JOIN ledger_period_state period ON period.group_id=? AND period.month=json_extract(value,'$.month')
      WHERE ${readyPeriod} GROUP BY json_extract(value,'$.month'),period.active_build_id,json_extract(value,'$.currency'),json_extract(value,'$.person_id')
      ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor,updated_at=excluded.updated_at`, [groupId, timestamp, contributionJson, groupId, ...readyPeriodArgs]),
    guarded(`WITH deltas AS (SELECT json_extract(value,'$.month') month,json_extract(value,'$.currency') currency,SUM(json_extract(value,'$.gross_minor')) gross_minor FROM json_each(?) GROUP BY month,currency)
      UPDATE ledger_period_totals SET gross_minor=gross_minor+(SELECT d.gross_minor FROM deltas d WHERE d.month=ledger_period_totals.month AND d.currency=ledger_period_totals.currency),updated_at=?
      WHERE group_id=? AND build_id=(SELECT active_build_id FROM ledger_period_state WHERE group_id=ledger_period_totals.group_id AND month=ledger_period_totals.month)
        AND EXISTS (SELECT 1 FROM deltas d WHERE d.month=ledger_period_totals.month AND d.currency=ledger_period_totals.currency)
        AND ${readyPeriod.replaceAll('json_extract\(value,\'\$\.month\'\)', 'ledger_period_totals.month')}
        AND gross_minor+(SELECT d.gross_minor FROM deltas d WHERE d.month=ledger_period_totals.month AND d.currency=ledger_period_totals.currency)>=0`, [grossJson, timestamp, groupId, ...readyPeriodArgs]),
    guarded(`WITH deltas AS (SELECT json_extract(value,'$.month') month,json_extract(value,'$.currency') currency,SUM(json_extract(value,'$.gross_minor')) gross_minor FROM json_each(?) GROUP BY month,currency)
      INSERT INTO ledger_period_totals(group_id,month,build_id,currency,gross_minor,updated_at)
      SELECT ?,d.month,(SELECT active_build_id FROM ledger_period_state WHERE group_id=? AND month=d.month),d.currency,d.gross_minor,?
      FROM deltas d WHERE ${readyPeriod.replaceAll('json_extract\(value,\'\$\.month\'\)', 'd.month')}
        AND NOT EXISTS (SELECT 1 FROM ledger_period_totals current_total WHERE current_total.group_id=? AND current_total.month=d.month AND current_total.currency=d.currency AND current_total.build_id=(SELECT active_build_id FROM ledger_period_state WHERE group_id=? AND month=d.month))
      GROUP BY d.month,d.currency HAVING d.gross_minor>=0`, [grossJson, groupId, groupId, timestamp, groupId, groupId, ...readyPeriodArgs]),
    guarded(`WITH deltas AS (SELECT json_extract(value,'$.currency') currency,SUM(json_extract(value,'$.gross_minor')) gross_minor FROM json_each(?) GROUP BY currency)
      UPDATE ledger_totals SET gross_minor=gross_minor+(SELECT d.gross_minor FROM deltas d WHERE d.currency=ledger_totals.currency),updated_at=?
      WHERE group_id=? AND EXISTS (SELECT 1 FROM deltas d WHERE d.currency=ledger_totals.currency)
        AND EXISTS (SELECT 1 FROM ledger_summary_state WHERE group_id=? AND status='ready' AND discovery_complete=1 AND maintenance_due=0)
        AND gross_minor+(SELECT d.gross_minor FROM deltas d WHERE d.currency=ledger_totals.currency)>=0`, [grossJson, timestamp, groupId, groupId]),
    guarded(`INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at)
      SELECT ?,json_extract(value,'$.currency'),SUM(json_extract(value,'$.gross_minor')),?
      FROM json_each(?) WHERE EXISTS (SELECT 1 FROM ledger_summary_state WHERE group_id=? AND status='ready' AND discovery_complete=1 AND maintenance_due=0)
        AND NOT EXISTS (SELECT 1 FROM ledger_totals current_total WHERE current_total.group_id=? AND current_total.currency=json_extract(value,'$.currency'))
      GROUP BY json_extract(value,'$.currency') HAVING SUM(json_extract(value,'$.gross_minor'))>=0`, [groupId, timestamp, grossJson, groupId, groupId]),
    guarded(`WITH deltas AS (SELECT json_extract(value,'$.month') month,json_extract(value,'$.currency') currency,json_extract(value,'$.person_id') person_id,SUM(json_extract(value,'$.net_minor')) net_minor FROM json_each(?) GROUP BY month,currency,person_id)
      INSERT INTO ledger_checkpoint_balances(group_id,currency,person_id,net_minor,updated_at)
      SELECT ?,d.currency,d.person_id,d.net_minor,? FROM deltas d
      WHERE d.net_minor<>0 AND EXISTS (SELECT 1 FROM ledger_summary_state state WHERE state.group_id=? AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0 AND state.checkpoint_through IS NOT NULL AND d.month<=state.checkpoint_through)
      ON CONFLICT(group_id,currency,person_id) DO UPDATE SET net_minor=ledger_checkpoint_balances.net_minor+excluded.net_minor,updated_at=excluded.updated_at`, [contributionJson, groupId, timestamp, groupId]),
     guarded(`WITH deltas AS (SELECT json_extract(value,'$.month') month,json_extract(value,'$.currency') currency,SUM(json_extract(value,'$.gross_minor')) gross_minor FROM json_each(?) GROUP BY month,currency), checkpoint_deltas AS (
         SELECT d.currency,SUM(d.gross_minor) gross_minor FROM deltas d JOIN ledger_summary_state state ON state.group_id=? AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0 AND state.checkpoint_through IS NOT NULL AND d.month<=state.checkpoint_through GROUP BY d.currency)
       UPDATE ledger_checkpoint_totals AS checkpoint SET gross_minor=checkpoint.gross_minor+(SELECT d.gross_minor FROM checkpoint_deltas d WHERE d.currency=checkpoint.currency),updated_at=?
       WHERE checkpoint.group_id=? AND EXISTS (SELECT 1 FROM checkpoint_deltas d WHERE d.currency=checkpoint.currency AND d.gross_minor<>0)
         AND checkpoint.gross_minor+(SELECT d.gross_minor FROM checkpoint_deltas d WHERE d.currency=checkpoint.currency) BETWEEN 0 AND 9007199254740991`, [grossJson, groupId, timestamp, groupId]),
     guarded(`WITH deltas AS (SELECT json_extract(value,'$.month') month,json_extract(value,'$.currency') currency,SUM(json_extract(value,'$.gross_minor')) gross_minor FROM json_each(?) GROUP BY month,currency), checkpoint_deltas AS (
         SELECT d.currency,SUM(d.gross_minor) gross_minor FROM deltas d JOIN ledger_summary_state state ON state.group_id=? AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0 AND state.checkpoint_through IS NOT NULL AND d.month<=state.checkpoint_through GROUP BY d.currency)
       INSERT INTO ledger_checkpoint_totals(group_id,currency,gross_minor,updated_at)
       SELECT ?,d.currency,d.gross_minor,? FROM checkpoint_deltas d WHERE d.gross_minor>0
         AND d.gross_minor<=9007199254740991
         AND NOT EXISTS (SELECT 1 FROM ledger_checkpoint_totals checkpoint WHERE checkpoint.group_id=? AND checkpoint.currency=d.currency)`, [grossJson, groupId, groupId, timestamp, groupId]),
    guarded(`UPDATE ledger_period_state SET source_generation=source_generation+1,
         status=CASE WHEN (SELECT status FROM ledger_summary_state WHERE group_id=?)='ready' AND (SELECT discovery_complete FROM ledger_summary_state WHERE group_id=?)=1 AND (SELECT maintenance_due FROM ledger_summary_state WHERE group_id=?)=0 AND status='ready' AND source_generation=applied_generation THEN 'ready' ELSE 'dirty' END,
         applied_generation=CASE WHEN (SELECT status FROM ledger_summary_state WHERE group_id=?)='ready' AND (SELECT discovery_complete FROM ledger_summary_state WHERE group_id=?)=1 AND (SELECT maintenance_due FROM ledger_summary_state WHERE group_id=?)=0 AND status='ready' AND source_generation=applied_generation THEN applied_generation+1 ELSE applied_generation END,
         build_generation=CASE WHEN (SELECT status FROM ledger_summary_state WHERE group_id=?)='ready' AND (SELECT discovery_complete FROM ledger_summary_state WHERE group_id=?)=1 AND (SELECT maintenance_due FROM ledger_summary_state WHERE group_id=?)=0 AND status='ready' AND source_generation=applied_generation THEN build_generation+1 ELSE build_generation END,
        updated_at=? WHERE group_id=? AND month IN (SELECT json_extract(value,'$.month') FROM json_each(?))`, [groupId, groupId, groupId, groupId, groupId, groupId, groupId, groupId, groupId, timestamp, groupId, contributionJson]),
  ];
}

const expenseContributions = (month: string, currency: string, payers: Array<{ personId: string; amountMinor: number }>, splits: Array<{ personId: string; amountMinor: number }>): Contribution[] => [
  ...payers.map((payer) => ({ month, currency, person_id: payer.personId, net_minor: payer.amountMinor })),
  ...splits.map((split) => ({ month, currency, person_id: split.personId, net_minor: -split.amountMinor })),
];
const settlementContributions = (month: string, currency: string, fromPersonId: string, toPersonId: string, amountMinor: number): Contribution[] => [
  { month, currency, person_id: fromPersonId, net_minor: amountMinor },
  { month, currency, person_id: toPersonId, net_minor: -amountMinor },
];

export function boundExpenseProjectionDelta(db: D1Database, expenseId: string, groupId: string, currency: string, payers: Array<{ personId: string; amountMinor: number }>, splits: Array<{ personId: string; amountMinor: number }>, sign: 1 | -1, timestamp: string, revisionId?: string, date = '0000-00-00') {
  const marker = revisionId ?? expenseId, month = ledgerMonth(date), mutation = { table: 'expenses' as const, id: expenseId, groupId, marker };
  return [
    ...legacyExpenseProjectionDelta(db, groupId, currency, payers, splits, sign, timestamp, mutation),
    ...summaryDelta(db, groupId, expenseContributions(month, currency, payers, splits), [{ month, currency, gross_minor: payers.reduce((total, payer) => total + payer.amountMinor, 0) }], sign, timestamp, mutation),
  ];
}

export function boundSettlementProjectionDelta(db: D1Database, settlementId: string, groupId: string, currency: string, fromPersonId: string, toPersonId: string, amountMinor: number, sign: 1 | -1, timestamp: string, revisionId?: string, date = '0000-00-00') {
  const marker = revisionId ?? settlementId, month = ledgerMonth(date), mutation = { table: 'settlements' as const, id: settlementId, groupId, marker };
  return [
    ...legacySettlementProjectionDelta(db, groupId, currency, fromPersonId, toPersonId, amountMinor, sign, timestamp, mutation),
    ...summaryDelta(db, groupId, settlementContributions(month, currency, fromPersonId, toPersonId, amountMinor), [{ month, currency, gross_minor: amountMinor }], sign, timestamp, mutation),
  ];
}

/**
 * 0021 Workers read this compact table while the monthly summary is being
 * rolled out.  Keep it exact for a ready legacy group, but touch only the
 * currency/person keys represented by this mutation.  The parent marker is
 * the batch guard: an authorization/version failure therefore cannot leave a
 * compatibility-only write behind.
 */
function legacyExpenseProjectionDelta(
  db: D1Database,
  groupId: string,
  currency: string,
  _payers: Array<{ personId: string; amountMinor: number }>,
  _splits: Array<{ personId: string; amountMinor: number }>,
  sign: 1 | -1,
  timestamp: string,
  mutation: Mutation,
) {
  // Read the children while the parent marker is held. On an edit the first
  // call runs before the old children are replaced and the second after the
  // new children are inserted, so no unbounded JSON list needs to cross the
  // D1 bind/command limit.
  const guard = mutationGuard(mutation), contributionSign = sign === 1 ? '1' : '-1';
  return [
    db.prepare(`WITH contributions AS (
        SELECT person_id,amount_minor FROM payers WHERE expense_id=?
        UNION ALL SELECT person_id,-amount_minor FROM splits WHERE expense_id=?
      ) INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at)
      SELECT ?,?,person_id,SUM(${contributionSign}*amount_minor),?
      FROM contributions
      WHERE EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=? AND state.status='ready')
        AND ${guard.sql}
      GROUP BY person_id
      ON CONFLICT(group_id,currency,person_id) DO UPDATE SET
        net_minor=group_balance_projection.net_minor+excluded.net_minor,updated_at=excluded.updated_at`).bind(mutation.id, mutation.id, groupId, currency, timestamp, groupId, ...guard.args),
  ];
}

function legacySettlementProjectionDelta(
  db: D1Database,
  groupId: string,
  currency: string,
  fromPersonId: string,
  toPersonId: string,
  amountMinor: number,
  sign: 1 | -1,
  timestamp: string,
  mutation: Mutation,
) {
  const guard = mutationGuard(mutation);
  return [
    db.prepare(`WITH contributions(person_id,net_minor) AS (VALUES(?,?),(?,?))
      INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at)
      SELECT ?,?,contributions.person_id,contributions.net_minor,? FROM contributions
      WHERE EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=? AND state.status='ready') AND ${guard.sql}
      ON CONFLICT(group_id,currency,person_id) DO UPDATE SET
        net_minor=group_balance_projection.net_minor+excluded.net_minor,updated_at=excluded.updated_at`).bind(fromPersonId, sign * amountMinor, toPersonId, -sign * amountMinor, groupId, currency, timestamp, groupId, ...guard.args),
  ];
}

export function projectionRevisionGuard(revisionId: string, entityType: 'expense' | 'settlement', entityId: string) {
  return { sql: 'EXISTS (SELECT 1 FROM revisions projection_revision WHERE projection_revision.id=? AND projection_revision.entity_type=? AND projection_revision.entity_id=?)', args: [revisionId, entityType, entityId] };
}

export function projectionMutation(_db: D1Database, _groupId: string, _timestamp: string, entity: 'expenses' | 'settlements', id: string, revisionId?: string) {
  const marker = revisionId ?? id;
  return _db.prepare(`UPDATE ${entity} SET projection_mutation_id=NULL WHERE id=? AND projection_mutation_id=?`).bind(id, marker);
}

/** Group list readiness is joined only after authorization has scoped groups. */
export const groupSelect = (requestedGroup = false) => `WITH authorized_groups AS (
    SELECT DISTINCT gm.group_id,gm.person_id,gm.role
    FROM group_members gm JOIN groups authorized_group ON authorized_group.id=gm.group_id
    WHERE gm.user_id=? AND gm.deleted_at IS NULL AND authorized_group.deleted_at IS NULL${requestedGroup ? ' AND gm.group_id=?' : ''}
  ), scoped_groups AS (SELECT DISTINCT group_id FROM authorized_groups),
  ready_groups AS (
    SELECT scope.group_id FROM scoped_groups scope JOIN ledger_summary_state state ON state.group_id=scope.group_id
    WHERE ${readyPredicate('state')}
  ),
  ready_ledger AS (
    SELECT cb.group_id,cb.currency,cb.person_id,cb.net_minor
      FROM ledger_checkpoint_balances cb JOIN ready_groups ready ON ready.group_id=cb.group_id
    UNION ALL
    SELECT pb.group_id,pb.currency,pb.person_id,pb.net_minor
      FROM ledger_period_balances pb JOIN ready_groups ready ON ready.group_id=pb.group_id
      JOIN ledger_period_state period ON period.group_id=pb.group_id AND period.month=pb.month AND period.active_build_id=pb.build_id
      JOIN ledger_summary_state state ON state.group_id=pb.group_id
      WHERE state.checkpoint_through IS NULL OR pb.month>state.checkpoint_through
  ), ledger AS (
    SELECT ready_ledger.group_id,ready_ledger.currency,ready_ledger.person_id,ready_ledger.net_minor FROM ready_ledger
    UNION ALL
    SELECT e.group_id,e.currency,p.person_id,p.amount_minor FROM expenses e JOIN scoped_groups scope ON scope.group_id=e.group_id JOIN payers p ON p.expense_id=e.id
      WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ready_groups ready WHERE ready.group_id=e.group_id)
    UNION ALL
    SELECT e.group_id,e.currency,s.person_id,-s.amount_minor FROM expenses e JOIN scoped_groups scope ON scope.group_id=e.group_id JOIN splits s ON s.expense_id=e.id
      WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ready_groups ready WHERE ready.group_id=e.group_id)
    UNION ALL
    SELECT s.group_id,s.currency,s.from_person_id,s.amount_minor FROM settlements s JOIN scoped_groups scope ON scope.group_id=s.group_id
      WHERE s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ready_groups ready WHERE ready.group_id=s.group_id)
    UNION ALL
    SELECT s.group_id,s.currency,s.to_person_id,-s.amount_minor FROM settlements s JOIN scoped_groups scope ON scope.group_id=s.group_id
      WHERE s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ready_groups ready WHERE ready.group_id=s.group_id)
  ), group_balances AS (
    SELECT ledger.group_id,ledger.currency,SUM(ledger.net_minor) AS net_minor FROM ledger
      JOIN authorized_groups balance_member ON balance_member.group_id=ledger.group_id AND balance_member.person_id=ledger.person_id
      GROUP BY ledger.group_id,ledger.currency HAVING SUM(ledger.net_minor)<>0
  ), ranked_balances AS (
    SELECT group_id,currency,net_minor,ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY ABS(net_minor) DESC,currency ASC) AS balance_rank FROM group_balances
  ), balance_json AS (
    SELECT group_id,json_group_array(json_object('currency',currency,'net_minor',net_minor)) AS balance_summaries
      FROM (SELECT group_id,currency,net_minor FROM ranked_balances WHERE balance_rank<=2 ORDER BY group_id,balance_rank) GROUP BY group_id
  )
  SELECT g.*,gm.role,
    (SELECT COUNT(*) FROM group_members member_count WHERE member_count.group_id=g.id AND member_count.deleted_at IS NULL) AS member_count,
    (SELECT p.name FROM people p JOIN group_members other_member ON other_member.person_id=p.id
      WHERE other_member.group_id=g.id AND other_member.person_id<>gm.person_id AND other_member.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY p.name LIMIT 1) AS counterpart_name,
    COALESCE(balance_json.balance_summaries,'[]') AS balance_summaries
  FROM groups g JOIN authorized_groups gm ON gm.group_id=g.id LEFT JOIN balance_json ON balance_json.group_id=g.id`;
