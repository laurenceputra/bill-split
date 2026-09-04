import type { D1Database, Queue, MessageBatch } from '@cloudflare/workers-types';
import { NOTIFICATION_DELIVERY_PAGE_SIZE, NOTIFICATION_MAX_ATTEMPTS, Repository, type NotificationDeliveryCandidate } from '../db/repository';
import { decryptSubscription, sendWebPush } from './web-push';

export type NotificationBindings = {
  DB: D1Database;
  IDENTITY_TOMBSTONE_KEY?: string;
  NOTIFICATION_QUEUE?: Queue<string>;
  PUSH_SUBSCRIPTION_ENCRYPTION_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_CONTACT?: string;
  ENVIRONMENT?: string;
};

const deliveryConfig = (env: NotificationBindings) => {
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const contact = env.VAPID_CONTACT?.trim();
  const encryptionKey = env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY?.trim();
  if (!privateKey || !publicKey || !contact || !encryptionKey) return undefined;
  return { privateKey, publicKey, contact, encryptionKey };
};
export const notificationConfig = (env: NotificationBindings) => env.NOTIFICATION_QUEUE ? deliveryConfig(env) : undefined;

const log = (record: Record<string, unknown>) => console.log(JSON.stringify({ event: 'bill-split.notifications', ...record }));

export async function flushNotificationOutbox(repo: Repository, queue: Queue<string>, asOf = new Date().toISOString()) {
  const eventIds = await repo.pendingNotificationEventIds(asOf, 100);
  if (!eventIds.length) return 0;
  try {
    await queue.sendBatch(eventIds.map((body) => ({ body, contentType: 'text' })));
    await repo.markNotificationEventsQueued(eventIds, asOf);
    log({ outcome: 'queued', count: eventIds.length });
    return eventIds.length;
  } catch (error) {
    log({ outcome: 'queue_failed', count: eventIds.length, error: error instanceof Error ? error.name : 'UNEXPECTED_ERROR' });
    return 0;
  }
}

const internalRouteFor = (candidate: NotificationDeliveryCandidate) => {
  const group = encodeURIComponent(candidate.groupId);
  const entity = encodeURIComponent(candidate.entityId);
  if (candidate.entityType === 'expense') return `/groups/${group}/expenses/${entity}`;
  if (candidate.entityType === 'settlement') return `/groups/${group}/settlements/${entity}`;
  return `/groups/${group}`;
};

export const notificationPayloadFor = (candidate: NotificationDeliveryCandidate) => {
  const type = candidate.eventType;
  const action = type.replace(/^(expense|settlement|scheduled_expense)_/, '').replace('_', ' ');
  const subject = type.startsWith('expense') ? 'expense' : type.startsWith('settlement') ? 'settlement' : 'scheduled expense';
  const title = candidate.detailLevel === 'detailed' && candidate.description ? candidate.description : 'BillSplit activity';
  const detail = candidate.detailLevel === 'detailed' && candidate.amountMinor != null && candidate.currency ? ` (${candidate.currency} ${(candidate.amountMinor / 100).toFixed(2)})` : '';
  const body = candidate.detailLevel === 'detailed' && candidate.description
    ? `${subject[0].toUpperCase()}${subject.slice(1)} ${action}${detail}.`
    : `A group ${subject} was ${action}.`;
  return JSON.stringify({ title, body, tag: `billsplit-${candidate.eventId}`, data: { eventId: candidate.eventId, recipientUserId: candidate.recipientUserId, route: internalRouteFor(candidate) } });
};

/** Fan out one opaque event ID. No endpoint, key, amount, or description is
 * included in queue messages; all recipient and preference decisions happen
 * against current D1 state here. */
export async function deliverNotificationEvent(repo: Repository, eventId: string, env: NotificationBindings, attempts = 1) {
  const config = deliveryConfig(env);
  if (!config) return { retry: false, disabled: true };
  const event = await repo.notificationEventForDelivery(eventId);
  if (!event) return { retry: false, missing: true };
  const claimOwner = crypto.randomUUID();
  await repo.recoverStaleNotificationDeliveryClaims(eventId, new Date().toISOString());
  const candidates = await repo.notificationDeliveryCandidates(eventId, new Date().toISOString());
  let retry = false;
  for (const candidate of candidates) {
    const claimed = await repo.claimNotificationDelivery(eventId, candidate.subscriptionId, claimOwner, new Date().toISOString());
    // A duplicate queue consumer, or a recipient whose authorization changed,
    // simply loses the claim and must not perform external push I/O.
    if (!claimed) continue;
    let subscription;
    try {
      subscription = await decryptSubscription(claimed.subscriptionCiphertext, config.encryptionKey);
    } catch {
      // A rotated/corrupt ciphertext cannot succeed on retry. Terminally mark
      // this delivery and revoke only the affected credential; other
      // recipients still get their delivery.
      await repo.markNotificationDeliveryFailed(eventId, claimed.subscriptionId, claimOwner, attempts, 'INVALID_CIPHERTEXT');
      await repo.revokePushSubscription(claimed.subscriptionId);
      log({ outcome: 'subscription_revoked', reason: 'INVALID_CIPHERTEXT' });
      continue;
    }
    try {
       const response = await sendWebPush(subscription, notificationPayloadFor({ ...claimed, eventType: event.eventType, description: event.description, amountMinor: event.amountMinor, currency: event.currency }), config);
       if (response.ok) {
         await repo.markNotificationDeliverySent(eventId, claimed.subscriptionId, claimOwner);
       } else if (response.status === 404 || response.status === 410) {
          await repo.markNotificationDeliveryFailed(eventId, claimed.subscriptionId, claimOwner, attempts, String(response.status));
          await repo.revokePushSubscription(claimed.subscriptionId);
         log({ outcome: 'subscription_revoked', reason: `HTTP_${response.status}` });
        } else if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
           const retryable = await repo.markNotificationDeliveryRetry(eventId, claimed.subscriptionId, claimOwner, attempts, String(response.status));
            // A pending D1 row is retriable. Once D1 marks it terminal, this
            // Queue message must not be retried: pagination continuation is
            // handled below with a fresh message and its own Queue budget.
            if (retryable) retry = true;
            else log({ outcome: 'delivery_failed', reason: 'RETRY_EXHAUSTED', eventId, subscriptionId: claimed.subscriptionId, attempts, error: String(response.status) });
       } else {
          await repo.markNotificationDeliveryFailed(eventId, claimed.subscriptionId, claimOwner, attempts, String(response.status));
          log({ outcome: 'delivery_failed', reason: 'PROVIDER_REJECTED', eventId, subscriptionId: claimed.subscriptionId, attempts, error: String(response.status) });
       }
    } catch (error) {
         const retryable = await repo.markNotificationDeliveryRetry(eventId, claimed.subscriptionId, claimOwner, attempts, error instanceof Error ? error.name : 'UNEXPECTED_ERROR');
          if (retryable) retry = true;
          else log({ outcome: 'delivery_failed', reason: 'RETRY_EXHAUSTED', eventId, subscriptionId: claimed.subscriptionId, attempts, error: error instanceof Error ? error.name : 'UNEXPECTED_ERROR' });
    }
  }
  // A page can be empty while a pending retry or an unmaterialized eligible
  // subscription still exists. Only the repository's durable check can decide
  // whether completion is safe; Queue retries are not pagination.
  const work = typeof repo.notificationDeliveryWorkRemaining === 'function'
    ? await repo.notificationDeliveryWorkRemaining(eventId, new Date().toISOString())
    : { remaining: candidates.length >= NOTIFICATION_DELIVERY_PAGE_SIZE, due: candidates.length >= NOTIFICATION_DELIVERY_PAGE_SIZE };
  if (work.remaining) return { retry, continuation: true, continuationDelaySeconds: work.due ? 0 : 30, maxAttempts: NOTIFICATION_MAX_ATTEMPTS };
  await repo.completeNotificationEvent(eventId);
  return { retry, continuation: false, maxAttempts: NOTIFICATION_MAX_ATTEMPTS };
}

export async function consumeNotificationQueue(batch: MessageBatch<string>, env: NotificationBindings, repository?: Repository) {
  if (!deliveryConfig(env)) {
    // Development and tests commonly omit both the queue and VAPID secrets.
    // Acking here prevents a permanently retrying disabled integration.
    batch.ackAll();
    return;
  }
  const repo = repository || new Repository(env.DB, env.IDENTITY_TOMBSTONE_KEY, { pushSubscriptionKey: env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY });
  for (const message of batch.messages) {
    if (typeof message.body !== 'string' || message.body.length > 200) { message.ack(); continue; }
    try {
      const result = await deliverNotificationEvent(repo, message.body, env, message.attempts + 1);
       if (result.retry) {
         // Provider failures retry this message, preserving message.attempts.
         // Pagination waits until the provider retry has completed; it is not
         // allowed to reset that Queue retry budget by enqueueing a replacement
         // message for an unfinished page.
         message.retry({ delaySeconds: 30 });
       } else if (result.continuation) {
        // Explicitly enqueue the next durable page. This is separate from a
        // provider retry and is acknowledged only after the enqueue succeeds.
        await env.NOTIFICATION_QUEUE!.send(message.body, { contentType: 'text', delaySeconds: result.continuationDelaySeconds });
        message.ack();
      }
      else message.ack();
    } catch (error) {
      log({ outcome: 'consumer_failed', error: error instanceof Error ? error.name : 'UNEXPECTED_ERROR' });
      message.retry({ delaySeconds: 30 });
    }
  }
}
