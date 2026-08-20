import { describe, expect, it } from 'vitest';
import { calculateNet, simplifyDebts } from './balances';
import { BalanceOverflowError } from '../shared/money';
describe('balances', () => it('handles multiple payers and settlements', () => {
  const net = calculateNet([{ personId: 'a', amountMinor: 600 }, { personId: 'b', amountMinor: 400 }], [{ personId: 'a', amountMinor: 300 }, { personId: 'b', amountMinor: 300 }, { personId: 'c', amountMinor: 400 }], [{ id: 's', groupId: 'g', fromPersonId: 'c', toPersonId: 'a', amountMinor: 100, currency: 'USD', date: '2025-01-01', createdAt: '', updatedAt: '', deletedAt: null, version: 1 }]);
  expect(net).toEqual({ a: 200, b: 100, c: -300 }); expect(simplifyDebts(net, 'USD').map((x) => x.amountMinor)).toEqual([200, 100]);
}));
describe('balance edge cases', () => {
  it('keeps an overpaying nonparticipant and currencies separate', () => {
    const usd = calculateNet([{ personId: 'payer', amountMinor: 1000 }], [{ personId: 'participant', amountMinor: 1000 }], [], 'USD');
    const eur = calculateNet([{ personId: 'other', amountMinor: 100 }], [{ personId: 'participant', amountMinor: 100 }], [], 'EUR');
    expect(usd).toEqual({ payer: 1000, participant: -1000 });
    expect(eur).toEqual({ other: 100, participant: -100 });
  });
  it('applies partial settlement in the correct direction', () => {
    const net = calculateNet([{ personId: 'a', amountMinor: 1000 }], [{ personId: 'b', amountMinor: 1000 }], [{ id: 's', groupId: 'g', fromPersonId: 'b', toPersonId: 'a', amountMinor: 300, currency: 'USD', date: '2025-01-01', createdAt: '', updatedAt: '', version: 1 }]);
    expect(net).toEqual({ a: 700, b: -700 });
    expect(simplifyDebts(net, 'USD')).toEqual([{ fromPersonId: 'b', fromName: 'b', toPersonId: 'a', toName: 'a', amountMinor: 700, currency: 'USD' }]);
  });
  it('rejects a net aggregate that exceeds the safe minor-unit range', () => {
    expect(() => calculateNet([{ personId: 'a', amountMinor: Number.MAX_SAFE_INTEGER }, { personId: 'a', amountMinor: 1 }], [])).toThrow(BalanceOverflowError);
    expect(() => simplifyDebts({ a: Number.MAX_SAFE_INTEGER + 1 }, 'USD')).toThrow(BalanceOverflowError);
  });
});
