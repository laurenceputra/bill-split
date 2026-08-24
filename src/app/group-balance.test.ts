import { describe, expect, it } from 'vitest';
import { groupBalanceDisplays, personalBalanceDisplay, personalBalances } from './group-balance';

describe('home group balance formatting', () => {
  it('distinguishes unavailable legacy data, settled groups, and signed balances', () => {
    expect(groupBalanceDisplays(undefined, 'USD')).toEqual([{ kind: 'unavailable', label: 'Balance unavailable', currency: 'USD' }]);
    expect(groupBalanceDisplays([], 'USD')).toEqual([{ kind: 'settled', label: 'Settled up', currency: 'USD' }]);
    expect(groupBalanceDisplays([{ currency: 'EUR', netMinor: 1250 }, { currency: 'USD', netMinor: -300 }], 'USD')).toEqual([
      { kind: 'balance', label: 'You are owed', amountMinor: 1250, currency: 'EUR' },
      { kind: 'balance', label: 'You owe', amountMinor: 300, currency: 'USD' },
    ]);
  });

  it('never renders more than two summary rows', () => {
    expect(groupBalanceDisplays([
      { currency: 'USD', netMinor: 100 },
      { currency: 'EUR', netMinor: 90 },
      { currency: 'GBP', netMinor: 80 },
    ], 'USD')).toHaveLength(2);
  });

  it('filters zero summaries and uses one default-currency settled fallback', () => {
    expect(groupBalanceDisplays([{ currency: 'EUR', netMinor: 0 }, { currency: 'USD', netMinor: 0 }], 'GBP')).toEqual([
      { kind: 'settled', label: 'Settled up', currency: 'GBP' },
    ]);
    expect(groupBalanceDisplays([{ currency: 'EUR', netMinor: 0 }, { currency: 'USD', netMinor: 300 }], 'GBP')).toEqual([
      { kind: 'balance', label: 'You are owed', amountMinor: 300, currency: 'USD' },
    ]);
  });
});

describe('personal balance labels', () => {
  it('uses positive raw net as owed and negative raw net as owing', () => {
    expect(personalBalanceDisplay({ personId: 'me', name: 'Me', netMinor: 1250, currency: 'USD' }, 'USD')).toMatchObject({ label: 'You are owed', amountMinor: 1250 });
    expect(personalBalanceDisplay({ personId: 'me', name: 'Me', netMinor: -300, currency: 'EUR' }, 'USD')).toMatchObject({ label: 'You owe', amountMinor: 300, currency: 'EUR' });
    expect(personalBalanceDisplay({ personId: 'me', name: 'Me', netMinor: 0, currency: 'USD' }, 'USD')).toMatchObject({ label: 'Settled up' });
  });

  it('selects the current person from every currency raw balance', () => {
    expect(personalBalances({ USD: { raw: [{ personId: 'me', name: 'Me', netMinor: 100, currency: 'USD' }] }, EUR: { raw: [{ personId: 'me', name: 'Me', netMinor: -50, currency: 'EUR' }] } }, 'me', 'USD')).toEqual([
      { kind: 'balance', label: 'You are owed', amountMinor: 100, currency: 'USD' },
      { kind: 'balance', label: 'You owe', amountMinor: 50, currency: 'EUR' },
    ]);
  });
});
