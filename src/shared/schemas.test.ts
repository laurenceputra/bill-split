import { describe, expect, it } from 'vitest';
import { assertFinancialInput, categorySuggestionInput, currencyOptions, expenseInput, friendInput, groupSplitDefaultInput, notificationPreferencesInput, pushSubscriptionInput, scheduledExpenseInput, supportedCurrencies } from './schemas';
import { isSupportedPushEndpoint } from './push-endpoints';
import { BalanceOverflowError } from './money';

const base = { description: 'Lunch', amount_minor: 1000, currency: 'USD' as const, date: '2025-01-01', payers: [{ person_id: '00000000-0000-4000-8000-000000000001', amount_minor: 1000 }], splits: [{ person_id: '00000000-0000-4000-8000-000000000001', amount_minor: 1000 }] };
describe('financial input', () => {
  it('bounds category suggestion descriptions to the expense contract', () => {
    expect(categorySuggestionInput.parse({ description: '  Lunch  ' }).description).toBe('Lunch');
    expect(categorySuggestionInput.safeParse({ description: 'x'.repeat(241) }).success).toBe(false);
  });
  it('rejects mismatched totals and unsafe integers', () => {
    expect(() => assertFinancialInput({ ...base, splits: [{ ...base.splits[0], amount_minor: 999 }] })).toThrow('Splits must sum');
    expect(expenseInput.safeParse({ ...base, amount_minor: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });
  it('accepts exact idempotency keys and integer values', () => {
    expect(expenseInput.parse({ ...base, client_operation_id: 'retry-1' }).client_operation_id).toBe('retry-1');
  });
  it('reports an aggregate overflow separately from an ordinary total mismatch', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(() => assertFinancialInput({ ...base, amount_minor: max, payers: [{ ...base.payers[0], amount_minor: max }, { person_id: '00000000-0000-4000-8000-000000000002', amount_minor: 1 }] })).toThrow(BalanceOverflowError);
  });
  it('rejects impossible dates and currencies with unsupported minor units', () => {
    expect(expenseInput.safeParse({ ...base, date: '2025-02-30' }).success).toBe(false);
    expect(expenseInput.safeParse({ ...base, currency: 'JPY' }).success).toBe(false);
  });
  it('keeps frontend currency options aligned with the validation source', () => {
    expect(currencyOptions.map((option) => option.value)).toEqual([...supportedCurrencies]);
  });
  it('keeps notification enablement out of account-wide content preferences', () => {
    expect(notificationPreferencesInput.safeParse({ money_changes: true, scheduled_events: true, detail_level: 'generic' }).success).toBe(true);
    expect(notificationPreferencesInput.safeParse({ enabled: false, money_changes: true, scheduled_events: true, detail_level: 'generic' }).success).toBe(false);
  });
  it('accepts only supported HTTPS browser push services and safe endpoint URLs', () => {
    expect(isSupportedPushEndpoint('https://web.push.apple.com/safari-opaque-push-token')).toBe(true);
    expect(isSupportedPushEndpoint('https://fcm.googleapis.com/wp/chrome-token')).toBe(true);
    expect(isSupportedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/firefox-token')).toBe(true);
    expect(pushSubscriptionInput.safeParse({ endpoint: 'https://fcm.googleapis.com/fcm/send/chrome-token', keys: { p256dh: 'A'.repeat(65), auth: 'A'.repeat(22) } }).success).toBe(true);
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/token',
      'https://evil.example/fcm/send/token',
      'https://fcm.googleapis.com:8443/fcm/send/token',
      'https://user:secret@fcm.googleapis.com/fcm/send/token',
      'https://fcm.googleapis.com/not-a-push-path/token',
      'https://web.push.apple.com/3/device/apple-token',
      'https://web.push.apple.com/',
      'https://web.push.apple.com/safari/token',
      'https://web.push.apple.com/safari-token?query=not-supported',
    ]) expect(isSupportedPushEndpoint(endpoint)).toBe(false);
  });
  it('accepts a client operation ID for retry-safe friend creation', () => {
    expect(friendInput.parse({ name: 'Friend', currency: 'USD', client_operation_id: 'friend-op' }).client_operation_id).toBe('friend-op');
    expect(friendInput.safeParse({ name: '   ', currency: 'USD', client_operation_id: 'friend-op' }).success).toBe(false);
  });
  it('validates weekly recurrence participants, dates, and IANA timezone', () => {
    const value = { ...base, start_date: '2026-01-01', frequency: 'weekly', interval: 1, weekdays: [1, 3], timezone: 'America/New_York' };
    expect(scheduledExpenseInput.parse(value).timezone).toBe('America/New_York');
    expect(scheduledExpenseInput.safeParse({ ...value, timezone: 'not/a-timezone' }).success).toBe(false);
    expect(scheduledExpenseInput.safeParse({ ...value, weekdays: [], end_date: '2025-12-31' }).success).toBe(false);
  });
  it('accepts valid schedules with more than 82 distinct participants', () => {
    const people = Array.from({ length: 82 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    const value = { ...base, amount_minor: 8200, start_date: '2026-01-01', end_date: null, frequency: 'monthly' as const, interval: 1, weekdays: [], timezone: 'UTC', payers: people.slice(0, 41).map((person_id) => ({ person_id, amount_minor: 200 })), splits: people.slice(41).map((person_id) => ({ person_id, amount_minor: 200 })) };
    expect(scheduledExpenseInput.safeParse(value).success).toBe(true);
  });
  it('validates party defaults without allowing exact or zero allocations', () => {
    const one = '00000000-0000-4000-8000-000000000001', two = '00000000-0000-4000-8000-000000000002';
    expect(groupSplitDefaultInput.safeParse({ method: 'equal', person_ids: [one, two] }).success).toBe(true);
    expect(groupSplitDefaultInput.safeParse({ method: 'exact', person_ids: [one] }).success).toBe(false);
    expect(groupSplitDefaultInput.safeParse({ method: 'percentage', person_ids: [one, two], values: [5000, 5000] }).success).toBe(true);
    expect(groupSplitDefaultInput.safeParse({ method: 'percentage', person_ids: [one, two], values: [0, 10000] }).success).toBe(false);
    expect(groupSplitDefaultInput.safeParse({ method: 'shares', person_ids: [one, two], values: [1, 2] }).success).toBe(true);
    expect(groupSplitDefaultInput.safeParse({ method: 'shares', person_ids: [one, two], values: [1, 1_000_000] }).success).toBe(false);
  });
});
