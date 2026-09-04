import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverNotificationEvent, flushNotificationOutbox, consumeNotificationQueue, notificationPayloadFor } from './notifications';
import { NOTIFICATION_DELIVERY_D1_QUERY_BUDGET, NOTIFICATION_DELIVERY_PAGE_SIZE, NOTIFICATION_QUEUE_MAX_BATCH_SIZE } from '../db/repository';
import type { Repository } from '../db/repository';

const { decrypt, send } = vi.hoisted(() => ({
  decrypt: vi.fn(async () => ({ endpoint: 'https://push.example.test/opaque', keys: { p256dh: 'client', auth: 'auth' } })),
  send: vi.fn(async () => new Response(null, { status: 201 })),
}));
vi.mock('./web-push', () => ({ decryptSubscription: decrypt, sendWebPush: send }));

const config = { DB: {} as never, NOTIFICATION_QUEUE: {} as never, PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'encryption', VAPID_PRIVATE_KEY: 'private', VAPID_PUBLIC_KEY: 'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU', VAPID_CONTACT: 'mailto:test@example.test' };
const event = { id: 'event-1', eventType: 'expense_created' as const, groupId: 'group-1', entityId: 'expense-1', actorId: 'actor-1', description: 'Dinner', amountMinor: 1200, currency: 'USD' };
const candidate = { eventId: 'event-1', eventType: 'expense_created' as const, subscriptionId: 'subscription-1', subscriptionCiphertext: 'v1.encrypted', detailLevel: 'generic' as const, recipientUserId: 'user-1', groupId: 'group-1', entityId: 'expense-1', entityType: 'expense' as const };

const repository = (overrides: Record<string, unknown> = {}) => ({
  notificationEventForDelivery: vi.fn(async () => event),
  notificationDeliveryCandidates: vi.fn(async () => [candidate]),
  recoverStaleNotificationDeliveryClaims: vi.fn(async () => 0),
  claimNotificationDelivery: vi.fn(async (_eventId: string, _subscriptionId: string, _owner: string) => candidate),
  markNotificationDeliverySent: vi.fn(async () => undefined),
  markNotificationDeliveryRetry: vi.fn(async () => true),
  markNotificationDeliveryFailed: vi.fn(async () => undefined),
  revokePushSubscription: vi.fn(async () => undefined),
  completeNotificationEvent: vi.fn(async () => undefined),
  ...overrides,
}) as unknown as Repository;

describe('notification delivery', () => {
  beforeEach(() => { decrypt.mockClear(); send.mockClear(); });

  it('documents the single-message queue bound and worst-case D1 budget', () => {
    expect(NOTIFICATION_QUEUE_MAX_BATCH_SIZE).toBe(1);
    // Event/recovery/fan-out/suppression plus work = 5, each of the three
    // candidates can use claim/read/retry/read = 4, then work is checked once.
    expect(NOTIFICATION_DELIVERY_D1_QUERY_BUDGET).toBe(5 + NOTIFICATION_DELIVERY_PAGE_SIZE * 4 + 1);
  });

  it('fans out only the current recipient candidates and completes a successful delivery', async () => {
    const repo = repository({ notificationDeliveryCandidates: vi.fn(async () => [candidate]) });
    await expect(deliverNotificationEvent(repo, 'event-1', config)).resolves.toMatchObject({ retry: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(repo.recoverStaleNotificationDeliveryClaims).toHaveBeenCalledWith('event-1', expect.any(String));
    expect(repo.markNotificationDeliverySent).toHaveBeenCalledWith('event-1', 'subscription-1', expect.any(String));
    expect(repo.completeNotificationEvent).toHaveBeenCalledWith('event-1');
  });

  it('does not notify an actor when the repository recipient filter returns no candidates', async () => {
    const repo = repository({ notificationDeliveryCandidates: vi.fn(async () => []) });
    await deliverNotificationEvent(repo, 'event-1', config);
    expect(send).not.toHaveBeenCalled();
    expect(repo.completeNotificationEvent).toHaveBeenCalledWith('event-1');
  });

  it('includes only a bounded internal route and the intended recipient in payload data', () => {
    const payload = JSON.parse(notificationPayloadFor(candidate));
    expect(payload.data).toEqual({ eventId: 'event-1', recipientUserId: 'user-1', route: '/groups/group-1/expenses/expense-1' });
    expect(payload.body).toContain('group expense');
  });

  it('uses the event snapshot for opted-in detail rather than live entity data', () => {
    const payload = JSON.parse(notificationPayloadFor({ ...candidate, detailLevel: 'detailed', description: 'Original dinner', amountMinor: 1200, currency: 'USD' }));
    expect(payload.title).toBe('Original dinner');
    expect(payload.body).toContain('USD 12.00');
  });

  it('revokes expired provider endpoints and retries transient provider errors', async () => {
    const goneRepo = repository(); send.mockResolvedValueOnce(new Response(null, { status: 410 }));
    await expect(deliverNotificationEvent(goneRepo, 'event-1', config)).resolves.toMatchObject({ retry: false });
    expect(goneRepo.revokePushSubscription).toHaveBeenCalledWith('subscription-1');
    expect(goneRepo.markNotificationDeliveryFailed).toHaveBeenCalledWith('event-1', 'subscription-1', expect.any(String), 1, '410');

    const retryRepo = repository(); send.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(deliverNotificationEvent(retryRepo, 'event-1', config, 2)).resolves.toMatchObject({ retry: true });
    expect(retryRepo.markNotificationDeliveryRetry).toHaveBeenCalledWith('event-1', 'subscription-1', expect.any(String), 2, '503');
  });

  it('revokes invalid ciphertext credentials without deleting their delivery row', async () => {
    const repo = repository();
    decrypt.mockRejectedValueOnce(new Error('invalid ciphertext'));
    await expect(deliverNotificationEvent(repo, 'event-1', config)).resolves.toMatchObject({ retry: false });
    expect(repo.markNotificationDeliveryFailed).toHaveBeenCalledWith('event-1', 'subscription-1', expect.any(String), 1, 'INVALID_CIPHERTEXT');
    expect(repo.revokePushSubscription).toHaveBeenCalledWith('subscription-1');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not resend an already-deduped delivery and a disabled integration is a no-op', async () => {
    const deduped = repository({ notificationDeliveryCandidates: vi.fn(async () => []) });
    await deliverNotificationEvent(deduped, 'event-1', config);
    await deliverNotificationEvent(deduped, 'event-1', { DB: {} as never });
    expect(send).not.toHaveBeenCalled();
    expect(deduped.completeNotificationEvent).toHaveBeenCalledTimes(1);
  });

  it('acks a duplicate for an already-completed event without creating or sending a delivery', async () => {
    const completed = repository({ notificationEventForDelivery: vi.fn(async () => null), notificationDeliveryCandidates: vi.fn() });
    await expect(deliverNotificationEvent(completed, 'completed-event', config)).resolves.toMatchObject({ retry: false, missing: true });
    expect(completed.notificationDeliveryCandidates).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('allows only one concurrent queue consumer to claim and send a delivery', async () => {
    let claimed = false;
    const repo = repository({
      claimNotificationDelivery: vi.fn(async () => {
        if (claimed) return null;
        claimed = true;
        return candidate;
      }),
    });
    await Promise.all([deliverNotificationEvent(repo, 'event-1', config), deliverNotificationEvent(repo, 'event-1', config)]);
    expect(repo.claimNotificationDelivery).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not send when the final authorization claim is lost', async () => {
    const repo = repository({ claimNotificationDelivery: vi.fn(async () => null) });
    await deliverNotificationEvent(repo, 'event-1', config);
    expect(send).not.toHaveBeenCalled();
    expect(repo.markNotificationDeliverySent).not.toHaveBeenCalled();
  });

  it('processes one bounded page and explicitly reports durable continuation', async () => {
    const firstPage = Array.from({ length: NOTIFICATION_DELIVERY_PAGE_SIZE }, (_, index) => ({ ...candidate, subscriptionId: `subscription-${index}` }));
    const secondPage = [{ ...candidate, subscriptionId: 'subscription-final' }];
    const pages = [firstPage, secondPage, []];
    const repo = repository({
      notificationDeliveryCandidates: vi.fn(async () => pages.shift() || []),
      claimNotificationDelivery: vi.fn(async (_eventId: string, subscriptionId: string) => ({ ...candidate, subscriptionId })),
      notificationDeliveryWorkRemaining: vi.fn(async () => ({ remaining: pages.length > 1, due: true })),
    });

    await expect(deliverNotificationEvent(repo, 'event-1', config)).resolves.toMatchObject({ continuation: true });
    expect(send).toHaveBeenCalledTimes(NOTIFICATION_DELIVERY_PAGE_SIZE);
    expect(repo.completeNotificationEvent).not.toHaveBeenCalled();
    await expect(deliverNotificationEvent(repo, 'event-1', config)).resolves.toMatchObject({ continuation: false });
    expect(send).toHaveBeenCalledTimes(NOTIFICATION_DELIVERY_PAGE_SIZE + 1);
    expect(repo.claimNotificationDelivery).toHaveBeenCalledTimes(NOTIFICATION_DELIVERY_PAGE_SIZE + 1);
    expect(repo.completeNotificationEvent).toHaveBeenCalledOnce();
  });

  it('does not retry a terminal provider failure', async () => {
    const repo = repository({ markNotificationDeliveryRetry: vi.fn(async () => false) });
    send.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(deliverNotificationEvent(repo, 'event-1', config, 5)).resolves.toMatchObject({ retry: false, continuation: false });
    expect(repo.markNotificationDeliveryRetry).toHaveBeenCalled();
  });

  it('uses the current queue message retry for transient provider failures', async () => {
    const sendContinuation = vi.fn(async () => undefined);
    const message = { body: 'event-1', attempts: 4, ack: vi.fn(), retry: vi.fn() };
    send.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const repo = repository({
      notificationDeliveryWorkRemaining: vi.fn(async () => ({ remaining: true, due: true })),
    });
    await consumeNotificationQueue({ messages: [message] } as never, { ...config, NOTIFICATION_QUEUE: { send: sendContinuation } as never }, repo);
    expect(sendContinuation).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(repo.markNotificationDeliveryRetry).toHaveBeenCalledWith('event-1', 'subscription-1', expect.any(String), 5, '503');
  });

  it('acks only after enqueueing a pagination continuation', async () => {
    const sendContinuation = vi.fn(async () => undefined);
    const message = { body: 'event-1', attempts: 4, ack: vi.fn(), retry: vi.fn() };
    const repo = repository({
      notificationDeliveryWorkRemaining: vi.fn(async () => ({ remaining: true, due: true })),
    });
    await consumeNotificationQueue({ messages: [message] } as never, { ...config, NOTIFICATION_QUEUE: { send: sendContinuation } as never }, repo);
    expect(sendContinuation).toHaveBeenCalledWith('event-1', { contentType: 'text', delaySeconds: 0 });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('enqueues a fresh continuation after a terminal failure on a page with more recipients', async () => {
    const sendContinuation = vi.fn(async () => undefined);
    const message = { body: 'event-1', attempts: 4, ack: vi.fn(), retry: vi.fn() };
    send.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const repo = repository({
      markNotificationDeliveryRetry: vi.fn(async () => false),
      notificationDeliveryWorkRemaining: vi.fn(async () => ({ remaining: true, due: true })),
    });

    await consumeNotificationQueue({ messages: [message] } as never, { ...config, NOTIFICATION_QUEUE: { send: sendContinuation } as never }, repo);

    expect(sendContinuation).toHaveBeenCalledWith('event-1', { contentType: 'text', delaySeconds: 0 });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe('notification outbox queueing', () => {
  it('puts only opaque event IDs on the queue and leaves failed sends pending', async () => {
    const queue = { sendBatch: vi.fn(async (messages: Array<{ body: string }>) => { expect(messages.map((message) => message.body)).toEqual(['event-1', 'event-2']); }) };
    const repo = { pendingNotificationEventIds: vi.fn(async () => ['event-1', 'event-2']), markNotificationEventsQueued: vi.fn(async () => undefined) } as unknown as Repository;
    await expect(flushNotificationOutbox(repo, queue as never, '2026-01-01T00:00:00.000Z')).resolves.toBe(2);
    expect(repo.markNotificationEventsQueued).toHaveBeenCalledWith(['event-1', 'event-2'], '2026-01-01T00:00:00.000Z');
  });

  it('acknowledges queue messages when delivery configuration is absent', async () => {
    const batch = { ackAll: vi.fn(), messages: [] };
    await consumeNotificationQueue(batch as never, { DB: {} as never });
    expect(batch.ackAll).toHaveBeenCalledOnce();
  });
});
