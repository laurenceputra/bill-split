import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_DELIVERY_D1_QUERY_BUDGET, NOTIFICATION_MAINTENANCE_BATCH_SIZE, Repository } from './repository';
import { encryptSubscription, endpointHash } from '../worker/web-push';
import { consumeNotificationQueue, deliverNotificationEvent, flushNotificationOutbox } from '../worker/notifications';

const { sendWebPush } = vi.hoisted(() => ({ sendWebPush: vi.fn(async () => new Response(null, { status: 201 })) }));
vi.mock('../worker/web-push', async () => ({
  ...(await vi.importActual<typeof import('../worker/web-push')>('../worker/web-push')),
  sendWebPush,
}));
// This test intentionally drives the authored Repository against Wrangler's
// local SQLite-backed D1, rather than a SQL-string mock.
// @ts-expect-error Node types are not shipped to the Worker build.
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

type Row = Record<string, unknown>;
type Execution = { rows: Row[]; changes: number };

/** D1's prepare endpoint accepts one statement and avoids starting a new
 * Wrangler process for every migration operation. Keep trigger bodies intact
 * while splitting the authored migration scripts. */
const statementsIn = (sql: string) => {
  const statements: string[] = [];
  let buffer = '', quote = '', lineComment = false, blockComment = false, trigger = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index], next = sql[index + 1];
    if (lineComment) { if (character === '\n') { lineComment = false; buffer += character; } continue; }
    if (blockComment) { if (character === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (!quote && character === '-' && next === '-') { lineComment = true; index += 1; continue; }
    if (!quote && character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (quote) {
      buffer += character;
      if (character === quote && next === quote) { buffer += next; index += 1; }
      else if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; buffer += character; continue; }
    if (character !== ';') { buffer += character; continue; }
    const text = buffer.trim();
    if (!trigger && /^CREATE\s+TRIGGER\b/i.test(text)) trigger = true;
    if (trigger && !/\bEND\s*$/i.test(text)) { buffer += ';'; continue; }
    if (text) statements.push(text);
    buffer = ''; trigger = false;
  }
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
};

class LocalD1Statement {
  private args: unknown[] = [];
  constructor(private readonly sql: string, private readonly execute: (sql: string, args: unknown[]) => Promise<Execution>) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() { return { results: (await this.execute(this.sql, this.args)).rows as T[] }; }
  async first<T>() { return (await this.all<T>()).results[0] ?? null; }
  async run() { return { meta: { changes: (await this.execute(this.sql, this.args)).changes } }; }
  bound() { return { sql: this.sql, args: this.args }; }
}

class LocalD1 {
  constructor(private readonly execute: (sql: string, args: unknown[]) => Promise<Execution>, private readonly executeBatch: (statements: Array<{ sql: string; args: unknown[] }>) => Promise<Execution[]>) {}
  prepare(sql: string) { return new LocalD1Statement(sql, this.execute); }
  async batch(statements: Array<{ bound: () => { sql: string; args: unknown[] } }>) {
    return (await this.executeBatch(statements.map((statement) => statement.bound()))).map((result) => ({ meta: { changes: result.changes } }));
  }
}

describe('notification event commits against local D1', () => {
  it('executes every expense and settlement lifecycle mutation and commits one event per mutation', async () => {
    const moduleUrl = (import.meta as ImportMeta & { url: string }).url;
    const miniflare = new Miniflare({ workers: [{ config: { type: 'worker', name: 'notification-test', compatibilityDate: '2025-08-01', env: { DB: { type: 'd1', id: 'bill-split-notifications-test' } }, manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default {};' } } } } }] });
    const db = await miniflare.getD1Database('DB');
    const migrationNames = [
      '0001_initial.sql', '0002_production_safety.sql', '0003_ledger_total_limits.sql',
      '0004_friend_idempotency_lookup.sql', '0005_clerk_identity.sql', '0006_scheduled_expenses.sql',
      '0007_scheduled_generation_claims.sql', '0008_scheduled_expense_completion.sql',
      '0009_scheduled_generation_cursor.sql', '0010_generated_expense_operation_namespace.sql',
      '0011_scheduled_expense_category.sql', '0012_invitations_audit_purge.sql', '0013_projection_layer.sql',
      '0014_projection_indexes.sql', '0015_audit_actor_snapshot.sql', '0016_projection_readiness_reset.sql',
      '0017_cleanup_indexes.sql', '0018_category_preferences.sql', '0019_group_membership_events.sql',
      '0020_account_deletion.sql', '0021_deleted_identity_tombstones.sql', '0022_application_sessions.sql',
      '0023_group_split_defaults.sql', '0024_incremental_projection_totals.sql',
      '0025_expense_suggestion_lookup.sql', '0026_notifications.sql', '0027_notification_maintenance_indexes.sql',
    ];
    const seed = `
      INSERT INTO users(id,email,created_at,updated_at) VALUES ('user-1','one@example.test','2026-01-01','2026-01-01'),('user-2','two@example.test','2026-01-01','2026-01-01'),('user-3','three@example.test','2026-01-01','2026-01-01');
      INSERT INTO people(id,name,email,user_id,created_at) VALUES ('person-1','One','one@example.test','user-1','2026-01-01'),('person-2','Two','two@example.test','user-2','2026-01-01'),('person-3','Three','three@example.test','user-3','2026-01-01');
      INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES ('group-1','Integration','USD','2026-01-01','2026-01-01');
      INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES ('group-1','person-1','user-1','2026-01-01','owner'),('group-1','person-2','user-2','2026-01-01','member'),('group-1','person-3','user-3','2026-01-01','member');
    `;
    let notificationQueryCount = 0;
    let countNotificationQueries = false;
    const execute = async (sql: string, args: unknown[] = []): Promise<Execution> => {
      if (countNotificationQueries) notificationQueryCount += 1;
      const statement = db.prepare(sql).bind(...args);
      if (/^\s*(EXPLAIN|SELECT|WITH|PRAGMA)\b/i.test(sql)) return { rows: (await statement.all<Row>()).results, changes: 0 };
      return { rows: [], changes: Number((await statement.run()).meta?.changes ?? 0) };
    };
    const executeBatch = async (statements: Array<{ sql: string; args: unknown[] }>) => {
      if (countNotificationQueries) notificationQueryCount += statements.length;
      const results = await db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.args)));
      return results.map((result) => ({ rows: [], changes: Number(result.meta?.changes ?? 0) }));
    };

    try {
      for (const name of migrationNames) {
        const sql = await readFile(new URL(`../../migrations/${name}`, moduleUrl), 'utf8');
        for (const statement of statementsIn(sql)) await db.prepare(statement).run();
      }
      for (const statement of statementsIn(seed)) await db.prepare(statement).run();
      const repo = new Repository(new LocalD1(execute, executeBatch) as never);
      const expenseInput = { description: 'Dinner', amount_minor: 1000, currency: 'USD' as const, date: '2026-01-01', payers: [{ person_id: 'person-1', amount_minor: 1000 }], splits: [{ person_id: 'person-2', amount_minor: 1000 }] };
      const expense = await repo.createExpense('group-1', 'user-1', expenseInput);
      const updatedExpense = await repo.updateExpense(expense.id, 'user-1', { ...expenseInput, description: 'Dinner updated', version: expense.version });
      await repo.deleteExpense(expense.id, 'user-1', updatedExpense.version);
      await repo.restoreExpense(expense.id, 'user-1', updatedExpense.version + 1);
      const settlementInput = { from_person_id: 'person-1', to_person_id: 'person-2', amount_minor: 250, currency: 'USD' as const, date: '2026-01-01', note: 'Payback' };
      const settlement = await repo.createSettlement('group-1', 'user-1', settlementInput);
      const updatedSettlement = await repo.updateSettlement(settlement.id, 'user-1', { ...settlementInput, amount_minor: 300, version: settlement.version });
      await repo.deleteSettlement(settlement.id, 'user-1', updatedSettlement.version);
      await repo.restoreSettlement(settlement.id, 'user-1', updatedSettlement.version + 1);
      await repo.createScheduledExpense('group-1', 'user-1', {
        description: 'Recurring dinner', amount_minor: 500, currency: 'USD', category: null,
        start_date: '2026-01-01', end_date: null, frequency: 'monthly', interval: 1, weekdays: [], timezone: 'UTC',
        payers: [{ person_id: 'person-1', amount_minor: 500 }], splits: [{ person_id: 'person-1', amount_minor: 500 }],
      });
      const blockedSchedule = await repo.createScheduledExpense('group-1', 'user-1', {
        description: 'Blocked recurring dinner', amount_minor: 400, currency: 'USD', category: null,
        start_date: '2026-01-01', end_date: null, frequency: 'monthly', interval: 1, weekdays: [], timezone: 'UTC',
        payers: [{ person_id: 'person-2', amount_minor: 400 }], splits: [{ person_id: 'person-1', amount_minor: 400 }],
      });
      await execute("UPDATE group_members SET deleted_at='2026-01-02' WHERE group_id='group-1' AND person_id='person-2'");
      await repo.generateDueScheduledExpenses('2026-01-02T00:00:00.000Z', { maxTemplates: 4, maxOccurrences: 4, maxOccurrencesPerTemplate: 2 });

      const events = (await execute('SELECT event_type,entity_type,entity_id,entity_version FROM notification_events ORDER BY rowid')).rows;
      expect(events).toEqual(expect.arrayContaining([
        { event_type: 'expense_created', entity_type: 'expense', entity_id: expense.id, entity_version: 1 },
        { event_type: 'expense_updated', entity_type: 'expense', entity_id: expense.id, entity_version: 2 },
        { event_type: 'expense_deleted', entity_type: 'expense', entity_id: expense.id, entity_version: 3 },
        { event_type: 'expense_restored', entity_type: 'expense', entity_id: expense.id, entity_version: 4 },
        { event_type: 'settlement_created', entity_type: 'settlement', entity_id: settlement.id, entity_version: 1 },
        { event_type: 'settlement_updated', entity_type: 'settlement', entity_id: settlement.id, entity_version: 2 },
        { event_type: 'settlement_deleted', entity_type: 'settlement', entity_id: settlement.id, entity_version: 3 },
        { event_type: 'settlement_restored', entity_type: 'settlement', entity_id: settlement.id, entity_version: 4 },
        expect.objectContaining({ event_type: 'scheduled_expense_generated', entity_type: 'expense' }),
        { event_type: 'scheduled_expense_blocked', entity_type: 'scheduled_expense', entity_id: blockedSchedule.id, entity_version: 2 },
      ]));
      expect((await execute('SELECT description,amount_minor,currency FROM expenses WHERE id=?', [expense.id])).rows).toEqual([{ description: 'Dinner updated', amount_minor: 1000, currency: 'USD' }]);
      expect((await execute('SELECT amount_minor FROM settlements WHERE id=?', [settlement.id])).rows).toEqual([{ amount_minor: 300 }]);
      // Deliver an event produced by a real repository mutation through the
      // same outbox flush and queue consumer used by the Worker. The actor is
      // user-1, so user-3 is the eligible recipient.
      const notificationRepo = new Repository(new LocalD1(execute, executeBatch) as never, undefined, { pushSubscriptionKey: 'integration-secret' });
       const endpoint = 'https://fcm.googleapis.com/fcm/send/queued-delivery';
       const subscription = await notificationRepo.upsertPushSubscription('user-3', { endpoint, keys: { p256dh: 'A'.repeat(65), auth: 'A'.repeat(22) } });
       await notificationRepo.upsertPushSubscription('user-3', { endpoint, keys: { p256dh: 'B'.repeat(65), auth: 'B'.repeat(22) } });
       expect((await execute("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id='user-3' AND revoked_at IS NULL")).rows).toEqual([{ count: 1 }]);
      await notificationRepo.updateNotificationPreferences('user-3', { money_changes: true, scheduled_events: true, detail_level: 'detailed' });
      const deliveredExpense = await repo.createExpense('group-1', 'user-1', {
        description: 'Queued dinner', amount_minor: 750, currency: 'USD', date: '2026-01-02',
        payers: [{ person_id: 'person-1', amount_minor: 750 }], splits: [{ person_id: 'person-3', amount_minor: 750 }],
      });
      const deliveredEvent = (await execute("SELECT id FROM notification_events WHERE event_type='expense_created' AND entity_type='expense' AND entity_id=? AND entity_version=1", [deliveredExpense.id])).rows[0];
      expect(deliveredEvent?.id).toEqual(expect.any(String));
      const deliveredEventId = String(deliveredEvent.id);
      const queuedEventIds: string[] = [];
      const notificationQueue = {
        sendBatch: vi.fn(async (messages: Array<{ body: string }>) => { queuedEventIds.push(...messages.map((message) => message.body)); }),
        send: vi.fn(async () => undefined),
      };
      const notificationEnv = {
        DB: new LocalD1(execute, executeBatch) as never,
        NOTIFICATION_QUEUE: notificationQueue as never,
        PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'integration-secret',
        VAPID_PRIVATE_KEY: 'private', VAPID_PUBLIC_KEY: 'public', VAPID_CONTACT: 'mailto:test@example.test',
      };
      await expect(flushNotificationOutbox(notificationRepo, notificationQueue as never)).resolves.toBeGreaterThan(0);
      expect(queuedEventIds).toContain(deliveredEventId);

      sendWebPush.mockClear();
      const firstQueueMessage = { body: deliveredEventId, attempts: 0, ack: vi.fn(), retry: vi.fn() };
      await consumeNotificationQueue({ messages: [firstQueueMessage] } as never, notificationEnv);
      expect(firstQueueMessage.ack).toHaveBeenCalledOnce();
      expect(firstQueueMessage.retry).not.toHaveBeenCalled();
      expect(sendWebPush).toHaveBeenCalledTimes(1);
      const providerCall = (sendWebPush.mock.calls as unknown as Array<[unknown, unknown]>)[0];
      expect(JSON.parse(String(providerCall?.[1])).data).toMatchObject({ eventId: deliveredEventId, recipientUserId: 'user-3' });
      expect((await execute('SELECT status FROM notification_deliveries WHERE event_id=? AND subscription_id=?', [deliveredEventId, subscription.id])).rows).toEqual([{ status: 'sent' }]);
      expect((await execute('SELECT completed_at IS NOT NULL AS completed FROM notification_events WHERE id=?', [deliveredEventId])).rows).toEqual([{ completed: 1 }]);

      // Replaying the same queue message after completion is an inert ack: it
      // must not invoke the provider or recreate its already-sent delivery.
      const duplicateQueueMessage = { body: deliveredEventId, attempts: 1, ack: vi.fn(), retry: vi.fn() };
      await consumeNotificationQueue({ messages: [duplicateQueueMessage] } as never, notificationEnv);
      expect(duplicateQueueMessage.ack).toHaveBeenCalledOnce();
      expect(duplicateQueueMessage.retry).not.toHaveBeenCalled();
      expect(sendWebPush).toHaveBeenCalledTimes(1);
      expect((await execute('SELECT COUNT(*) AS count FROM notification_deliveries WHERE event_id=?', [deliveredEventId])).rows).toEqual([{ count: 1 }]);
        const destinationEndpoints = Array.from({ length: 10 }, (_, index) => `https://fcm.googleapis.com/fcm/send/cap-${index}`);
        const reactivationEndpoint = 'https://fcm.googleapis.com/fcm/send/revoked-at-cap';
        const reactivationSubscription = await notificationRepo.upsertPushSubscription('user-2', { endpoint: reactivationEndpoint, keys: { p256dh: 'C'.repeat(65), auth: 'C'.repeat(22) } });
        await execute('UPDATE push_subscriptions SET revoked_at=? WHERE id=?', ['2026-01-03T00:00:00.000Z', reactivationSubscription.id]);
        const destinationSubscriptions = [];
        for (const destinationEndpoint of destinationEndpoints) destinationSubscriptions.push(await notificationRepo.upsertPushSubscription('user-2', { endpoint: destinationEndpoint, keys: { p256dh: 'C'.repeat(65), auth: 'C'.repeat(22) } }));
        await expect(notificationRepo.upsertPushSubscription('user-2', { endpoint: reactivationEndpoint, keys: { p256dh: 'D'.repeat(65), auth: 'D'.repeat(22) } })).rejects.toMatchObject({ code: 'PUSH_SUBSCRIPTION_LIMIT', details: { limit: 10 } });
        await expect(notificationRepo.upsertPushSubscription('user-2', { endpoint: destinationEndpoints[0], keys: { p256dh: 'D'.repeat(65), auth: 'D'.repeat(22) } })).resolves.toMatchObject({ id: destinationSubscriptions[0].id });
        await expect(notificationRepo.upsertPushSubscription('user-2', { endpoint, keys: { p256dh: 'D'.repeat(65), auth: 'D'.repeat(22) } })).rejects.toMatchObject({ code: 'PUSH_SUBSCRIPTION_LIMIT', details: { limit: 10 } });
       expect((await execute('SELECT user_id FROM push_subscriptions WHERE endpoint_hash=?', [await endpointHash(endpoint, 'integration-secret')])).rows).toEqual([{ user_id: 'user-3' }]);
       await execute("INSERT INTO notification_events(id,event_type,group_id,entity_type,entity_id,entity_version,actor_id,occurred_at) VALUES('transfer-event','expense_created','group-1','expense',?,1,'user-1','2026-01-04T00:00:00.000Z')", [expense.id]);
       await execute("INSERT INTO notification_deliveries(event_id,subscription_id,status,attempts,next_attempt_at,updated_at) VALUES('transfer-event',?,'pending',0,'2026-01-04T00:00:00.000Z','2026-01-04T00:00:00.000Z')", [subscription.id]);
        await notificationRepo.deletePushSubscription('user-2', destinationEndpoints[0]);
        const transferred = await notificationRepo.upsertPushSubscription('user-2', { endpoint, keys: { p256dh: 'D'.repeat(65), auth: 'D'.repeat(22) } });
        expect(transferred.id).not.toBe(subscription.id);
        expect((await execute("SELECT user_id,revoked_at FROM push_subscriptions WHERE id=?", [subscription.id])).rows).toEqual([{ user_id: 'user-3', revoked_at: expect.any(String) }]);
        expect((await execute("SELECT user_id,revoked_at FROM push_subscriptions WHERE id=?", [transferred.id])).rows).toEqual([{ user_id: 'user-2', revoked_at: null }]);
        expect((await execute("SELECT event_id,subscription_id FROM notification_deliveries WHERE event_id='transfer-event'")).rows).toEqual([{ event_id: 'transfer-event', subscription_id: subscription.id }]);
        for (const destinationEndpoint of destinationEndpoints.slice(1)) await notificationRepo.deletePushSubscription('user-2', destinationEndpoint);
        await expect(notificationRepo.deletePushSubscription('user-2', endpoint)).resolves.toBe(true);
        expect((await execute("SELECT revoked_at FROM push_subscriptions WHERE id=?", [transferred.id])).rows).toEqual([{ revoked_at: expect.any(String) }]);
        expect((await execute("SELECT event_id,subscription_id FROM notification_deliveries WHERE event_id='transfer-event'")).rows).toEqual([{ event_id: 'transfer-event', subscription_id: subscription.id }]);

      // A large recipient set is consumed in durable pages. Replaying the
      // event after completion must not recreate rows or invoke the provider.
      await execute("INSERT INTO notification_events(id,event_type,group_id,entity_type,entity_id,entity_version,actor_id,occurred_at) VALUES('fanout-event','expense_created','group-1', 'expense', ?, 1, 'user-1','2026-01-04T00:00:00.000Z')", [expense.id]);
       for (let index = 0; index < 5; index += 1) {
         const fanoutEndpoint = `https://fcm.googleapis.com/fcm/send/fanout-${index}`;
        await execute("INSERT INTO push_subscriptions(id,user_id,endpoint_hash,subscription_ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,?)", [
          `fanout-subscription-${index}`, 'user-3', await endpointHash(fanoutEndpoint, 'integration-secret'), await encryptSubscription({ endpoint: fanoutEndpoint, keys: { p256dh: 'B'.repeat(65), auth: 'B'.repeat(22) } }, 'integration-secret'), '2026-01-04', '2026-01-04',
         ]);
       }
       const expiredDeliveryEndpoint = 'https://fcm.googleapis.com/fcm/send/expired-delivery';
       await execute("INSERT INTO push_subscriptions(id,user_id,endpoint_hash,subscription_ciphertext,expiration_time,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", [
         'expired-subscription-delivery', 'user-3', await endpointHash(expiredDeliveryEndpoint, 'integration-secret'), await encryptSubscription({ endpoint: expiredDeliveryEndpoint, keys: { p256dh: 'X'.repeat(65), auth: 'X'.repeat(22) } }, 'integration-secret'), Date.parse('2025-12-01'), '2025-12-01', '2025-12-01',
       ]);
       sendWebPush.mockClear();
       countNotificationQueries = true;
       await expect(deliverNotificationEvent(notificationRepo, 'fanout-event', {
        DB: new LocalD1(execute, executeBatch) as never,
        PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'integration-secret',
        VAPID_PRIVATE_KEY: 'private', VAPID_PUBLIC_KEY: 'public', VAPID_CONTACT: 'mailto:test@example.test',
       })).resolves.toMatchObject({ continuation: true });
       countNotificationQueries = false;
       expect(notificationQueryCount).toBeLessThanOrEqual(NOTIFICATION_DELIVERY_D1_QUERY_BUDGET);
       expect((await execute("SELECT id FROM push_subscriptions WHERE id='expired-subscription-delivery'")).rows).toEqual([{ id: 'expired-subscription-delivery' }]);
      await expect(deliverNotificationEvent(notificationRepo, 'fanout-event', {
        DB: new LocalD1(execute, executeBatch) as never,
        PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'integration-secret',
        VAPID_PRIVATE_KEY: 'private', VAPID_PUBLIC_KEY: 'public', VAPID_CONTACT: 'mailto:test@example.test',
      })).resolves.toMatchObject({ continuation: false });
      await expect(deliverNotificationEvent(notificationRepo, 'fanout-event', {
        DB: new LocalD1(execute, executeBatch) as never,
        PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'integration-secret',
        VAPID_PRIVATE_KEY: 'private', VAPID_PUBLIC_KEY: 'public', VAPID_CONTACT: 'mailto:test@example.test',
      })).resolves.toMatchObject({ missing: true, retry: false });
      expect(sendWebPush).toHaveBeenCalledTimes(5);
       expect((await execute("SELECT COUNT(*) AS count FROM notification_deliveries WHERE event_id='fanout-event'")).rows).toEqual([{ count: 5 }]);
       expect((await execute("SELECT completed_at IS NOT NULL AS completed FROM notification_events WHERE id='fanout-event'")).rows).toEqual([{ completed: 1 }]);
       const subscriptionId = 'fanout-subscription-0';
       await execute("INSERT INTO notification_events(id,event_type,group_id,entity_type,entity_id,entity_version,occurred_at) VALUES('recovery-event','expense_created','group-1','expense',?,1,'2026-01-05')", [expense.id]);
       await execute("INSERT INTO notification_events(id,event_type,group_id,entity_type,entity_id,entity_version,occurred_at) VALUES('other-recovery-event','expense_created','group-1','expense',?,1,'2026-01-05')", [expense.id]);
       for (const [eventId, recoverySubscriptionId] of [['recovery-event', 'fanout-subscription-0'], ['recovery-event', 'fanout-subscription-1'], ['other-recovery-event', 'fanout-subscription-2']]) {
         await execute("INSERT INTO notification_deliveries(event_id,subscription_id,status,attempts,next_attempt_at,claim_owner,claim_until,updated_at) VALUES(?,?, 'claimed',0,?,?,?,?)", [eventId, recoverySubscriptionId, '2026-01-05', 'stale-owner', '2026-01-01', '2026-01-05']);
       }
       expect(await notificationRepo.recoverStaleNotificationDeliveryClaims('recovery-event', '2026-01-06', 1)).toBe(1);
       expect((await execute("SELECT event_id,status FROM notification_deliveries WHERE event_id LIKE '%recovery-event' ORDER BY event_id,subscription_id")).rows).toEqual([
         { event_id: 'other-recovery-event', status: 'claimed' },
         { event_id: 'recovery-event', status: 'pending' },
         { event_id: 'recovery-event', status: 'claimed' },
       ]);
       for (let index = 0; index < NOTIFICATION_MAINTENANCE_BATCH_SIZE + 2; index += 1) {
         const expiredSubscriptionId = `expired-subscription-${index}`;
         const expiredEndpoint = `https://fcm.googleapis.com/fcm/send/expired-${index}`;
         await execute("INSERT INTO push_subscriptions(id,user_id,endpoint_hash,subscription_ciphertext,expiration_time,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", [
           expiredSubscriptionId, 'user-3', await endpointHash(expiredEndpoint, 'integration-secret'), await encryptSubscription({ endpoint: expiredEndpoint, keys: { p256dh: 'E'.repeat(65), auth: 'E'.repeat(22) } }, 'integration-secret'), Date.parse('2025-12-01'), '2025-12-01', '2025-12-01',
         ]);
         await execute("INSERT INTO notification_events(id,event_type,group_id,entity_type,entity_id,entity_version,occurred_at,completed_at) VALUES(?,?,?,?,?,1,?,?)", [`expired-event-${index}`, 'expense_created', 'group-1', 'expense', expense.id, '2025-12-01', '2025-12-01']);
         await execute("INSERT INTO notification_deliveries(event_id,subscription_id,status,attempts,next_attempt_at,updated_at) VALUES(?,?, 'sent',1,?,?)", [`expired-event-${index}`, expiredSubscriptionId, '2025-12-01', '2025-12-01']);
       }
         notificationQueryCount = 0;
        countNotificationQueries = true;
        const maintenance = await notificationRepo.purgeNotificationData('2026-02-10T00:00:00.000Z', NOTIFICATION_MAINTENANCE_BATCH_SIZE);
        countNotificationQueries = false;
        expect(notificationQueryCount).toBe(5);
        expect(maintenance.expiredSubscriptionDeliveriesPurged).toBe(NOTIFICATION_MAINTENANCE_BATCH_SIZE);
        expect(maintenance.subscriptionsPurged).toBe(NOTIFICATION_MAINTENANCE_BATCH_SIZE);
         expect(maintenance.subscriptionsPurged).toBeLessThanOrEqual(NOTIFICATION_MAINTENANCE_BATCH_SIZE);
         expect(Number(((await execute("SELECT COUNT(*) AS count FROM push_subscriptions WHERE id LIKE 'expired-subscription-%'")).rows[0] as Row | undefined)?.count ?? 0)).toBeGreaterThan(0);
        for (let pass = 0; pass < 5; pass += 1) await notificationRepo.purgeNotificationData('2026-02-10T00:00:00.000Z', NOTIFICATION_MAINTENANCE_BATCH_SIZE);
        expect((await execute("SELECT COUNT(*) AS count FROM push_subscriptions WHERE id LIKE 'expired-subscription-%'")).rows).toEqual([{ count: 0 }]);
        expect((await execute("SELECT COUNT(*) AS count FROM notification_deliveries WHERE subscription_id LIKE 'expired-subscription-%'")).rows).toEqual([{ count: 0 }]);

        // A single revoked subscription can have more children than one page.
        // The first pass drains only the child page and must leave its parent.
        const pagedSubscriptionId = 'paged-expired-subscription';
        const pagedEndpoint = 'https://fcm.googleapis.com/fcm/send/paged-expired';
        await execute("INSERT INTO push_subscriptions(id,user_id,endpoint_hash,subscription_ciphertext,expiration_time,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)", [
          pagedSubscriptionId, 'user-3', await endpointHash(pagedEndpoint, 'integration-secret'), await encryptSubscription({ endpoint: pagedEndpoint, keys: { p256dh: 'P'.repeat(65), auth: 'P'.repeat(22) } }, 'integration-secret'), null, '2025-12-01', '2025-12-01', '2025-12-01',
        ]);
        for (let index = 0; index < NOTIFICATION_MAINTENANCE_BATCH_SIZE + 1; index += 1) {
          const eventId = `paged-expired-event-${index}`;
          await execute("INSERT INTO notification_events(id,event_type,group_id,entity_type,entity_id,entity_version,occurred_at,completed_at) VALUES(?,?,?,?,?,1,?,?)", [eventId, 'expense_created', 'group-1', 'expense', expense.id, '2026-02-01', '2026-02-01']);
          await execute("INSERT INTO notification_deliveries(event_id,subscription_id,status,attempts,next_attempt_at,updated_at) VALUES(?,?, 'sent',1,?,?)", [eventId, pagedSubscriptionId, '2026-02-01', '2026-02-01']);
        }
        const pagedFirst = await notificationRepo.purgeNotificationData('2026-02-10T00:00:00.000Z', NOTIFICATION_MAINTENANCE_BATCH_SIZE);
        expect(pagedFirst.expiredSubscriptionDeliveriesPurged).toBe(NOTIFICATION_MAINTENANCE_BATCH_SIZE);
        expect(pagedFirst.subscriptionsPurged).toBe(0);
        expect((await execute('SELECT id FROM push_subscriptions WHERE id=?', [pagedSubscriptionId])).rows).toEqual([{ id: pagedSubscriptionId }]);
        expect((await execute('SELECT COUNT(*) AS count FROM notification_deliveries WHERE subscription_id=?', [pagedSubscriptionId])).rows).toEqual([{ count: 1 }]);
        const pagedSecond = await notificationRepo.purgeNotificationData('2026-02-10T00:00:00.000Z', NOTIFICATION_MAINTENANCE_BATCH_SIZE);
        expect(pagedSecond.expiredSubscriptionDeliveriesPurged).toBe(1);
        expect(pagedSecond.subscriptionsPurged).toBe(1);
        expect((await execute('SELECT id FROM push_subscriptions WHERE id=?', [pagedSubscriptionId])).rows).toEqual([]);
        expect((await execute('SELECT COUNT(*) AS count FROM notification_deliveries WHERE subscription_id=?', [pagedSubscriptionId])).rows).toEqual([{ count: 0 }]);

        await execute("INSERT INTO notification_events(id,event_type,group_id,entity_type,entity_id,entity_version,occurred_at,completed_at) VALUES('old-event','expense_created','group-1','expense',?,'1','2025-12-01','2026-01-01')", [expense.id]);
       await execute("INSERT INTO notification_deliveries(event_id,subscription_id,status,attempts,next_attempt_at,updated_at) VALUES('old-event',?,'sent',1,'2025-12-01','2026-01-01')", [subscriptionId]);
       await notificationRepo.purgeNotificationData('2026-02-10T00:00:00.000Z', 10);
       expect((await execute("SELECT event_id FROM notification_deliveries WHERE event_id='old-event'")).rows).toEqual([]);
       expect((await execute("SELECT id FROM notification_events WHERE id='old-event'")).rows).toEqual([]);

        // Retention is independently paged: a full first page must not make
        // the event disappear while its last delivery still exists.
        for (let index = 0; index < NOTIFICATION_MAINTENANCE_BATCH_SIZE + 1; index += 1) {
          const eventId = `retained-event-${index}`;
          await execute("INSERT INTO notification_events(id,event_type,group_id,entity_type,entity_id,entity_version,occurred_at,completed_at) VALUES(?,?,?,?,?,1,?,?)", [eventId, 'expense_created', 'group-1', 'expense', expense.id, '2025-12-01', '2026-01-01']);
          await execute("INSERT INTO notification_deliveries(event_id,subscription_id,status,attempts,next_attempt_at,updated_at) VALUES(?,?, 'sent',1,?,?)", [eventId, subscriptionId, '2025-12-01', '2026-01-01']);
        }
        const retainedFirst = await notificationRepo.purgeNotificationData('2026-02-10T00:00:00.000Z', NOTIFICATION_MAINTENANCE_BATCH_SIZE);
        expect(retainedFirst.deliveriesPurged).toBe(NOTIFICATION_MAINTENANCE_BATCH_SIZE);
        expect(retainedFirst.eventsPurged).toBe(NOTIFICATION_MAINTENANCE_BATCH_SIZE);
        expect((await execute("SELECT COUNT(*) AS count FROM notification_deliveries WHERE event_id LIKE 'retained-event-%'")).rows).toEqual([{ count: 1 }]);
        expect((await execute("SELECT COUNT(*) AS count FROM notification_events WHERE id LIKE 'retained-event-%'")).rows).toEqual([{ count: 1 }]);
        const retainedSecond = await notificationRepo.purgeNotificationData('2026-02-10T00:00:00.000Z', NOTIFICATION_MAINTENANCE_BATCH_SIZE);
        expect(retainedSecond.deliveriesPurged).toBe(1);
        expect(retainedSecond.eventsPurged).toBe(1);
        expect((await execute("SELECT COUNT(*) AS count FROM notification_deliveries WHERE event_id LIKE 'retained-event-%'")).rows).toEqual([{ count: 0 }]);
        expect((await execute("SELECT COUNT(*) AS count FROM notification_events WHERE id LIKE 'retained-event-%'")).rows).toEqual([{ count: 0 }]);

        // Deleted-group notification history is drained in bounded child/event
        // pages before the group parent can be removed. The parent guard uses
        // the group-leading index, so a large history cannot hide behind a
        // cascading DELETE.
        await execute("INSERT INTO groups(id,name,currency,created_at,updated_at,deleted_at) VALUES('group-notification-history','History','USD','2026-01-01','2026-01-01','2026-01-02T00:00:00.000Z'); INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES('group-notification-history','person-1','user-1','2026-01-01','owner'); INSERT INTO notification_events(id,event_type,group_id,entity_type,entity_id,entity_version,occurred_at) VALUES('group-notification-history-event','expense_created','group-notification-history','expense','missing-expense',1,'2026-01-02T00:00:00.000Z');");
        await execute("WITH RECURSIVE sequence(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM sequence WHERE n<100) INSERT INTO push_subscriptions(id,user_id,endpoint_hash,subscription_ciphertext,created_at,updated_at) SELECT 'group-history-subscription-'||n,'user-1',printf('%064d',n),'ciphertext','2026-01-02','2026-01-02' FROM sequence");
        await execute("WITH RECURSIVE sequence(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM sequence WHERE n<100) INSERT INTO notification_deliveries(event_id,subscription_id,status,attempts,next_attempt_at,updated_at) SELECT 'group-notification-history-event','group-history-subscription-'||n,'sent',1,'2026-01-02','2026-01-02' FROM sequence");
        const eventGuardPlan = JSON.stringify((await execute("EXPLAIN QUERY PLAN SELECT 1 FROM notification_events WHERE group_id=? LIMIT 1", ['group-notification-history'])).rows);
        expect(eventGuardPlan).toContain('idx_notification_events_group_purge');
        const historyFirst = await notificationRepo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 100, maxGroups: 1 });
        expect(historyFirst.groupsPurged).toBe(0);
        expect((await execute("SELECT id FROM groups WHERE id='group-notification-history'")).rows).toEqual([{ id: 'group-notification-history' }]);
        expect((await execute("SELECT COUNT(*) AS count FROM notification_deliveries WHERE event_id='group-notification-history-event'")).rows).toEqual([{ count: 1 }]);
        expect((await execute("SELECT id FROM notification_events WHERE id='group-notification-history-event'")).rows).toEqual([{ id: 'group-notification-history-event' }]);
        const historySecond = await notificationRepo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 100, maxGroups: 1 });
        expect(historySecond.groupsPurged).toBe(1);
        expect((await execute("SELECT id FROM groups WHERE id='group-notification-history'")).rows).toEqual([]);
        expect((await execute("SELECT id FROM notification_events WHERE id='group-notification-history-event'")).rows).toEqual([]);

        // Soft account deletion revokes credential parents without invoking
        // their delivery cascade; the one-row preference is safe to remove.
        await execute("UPDATE users SET deleted_at='2026-02-10T00:00:00.000Z' WHERE id='user-3'");
        expect((await execute("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id='user-3' AND revoked_at IS NULL")).rows).toEqual([{ count: 0 }]);
        expect((await execute("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id='user-3'")).rows[0]?.count).toBeGreaterThan(0);
        expect((await execute("SELECT user_id FROM notification_preferences WHERE user_id='user-3'")).rows).toEqual([]);
      } finally {
      await miniflare.dispose();
    }
  }, 900_000);
});
