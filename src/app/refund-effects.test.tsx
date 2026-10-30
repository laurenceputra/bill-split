import { describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Credit } from '../shared/types';
import { projectedRefundBalance, refundBalanceSummary, refundBalanceText, refundPairOutcome, refundTransferHelp, savedRefundEffects } from './refund-effects';
import { RefundRecordEffects } from './refund-record-effects';

const credit: Credit = { id: 'refund', groupId: 'demo', subtype: 'refund', deliveryMode: 'member_reimbursement', amountMinor: 1000, currency: 'USD', date: '2026-01-01', createdBy: 'demo', createdAt: '', updatedAt: '', version: 1, applications: [], allocations: [
  { personId: 'one', allocationType: 'recipient', amountMinor: 1000 },
  { personId: 'one', allocationType: 'beneficiary', amountMinor: 400 },
  { personId: 'two', allocationType: 'beneficiary', amountMinor: 600 },
] };

describe('refund explanations', () => {
  const raw = (net: number) => [{ personId: 'me', name: 'Me', netMinor: net, currency: 'SGD' as const }, { personId: 'alex', name: 'Alex', netMinor: -net, currency: 'SGD' as const }];
  const pair = (net: number, delta: number, ids = ['me', 'alex']) => refundPairOutcome(ids, raw(net), 'me', () => 'Alex', 'SGD', (id) => id === 'me' ? delta : -delta);
  it('names the single two-person outcome and compares same-direction amounts', () => {
    expect(pair(-120000, 20000)).toEqual({ outcome: 'You’ll owe Alex SGD 1,000.00', detail: 'Down from SGD 1,200.00.' });
    expect(pair(100, 100)).toEqual({ outcome: 'Alex will owe you SGD 2.00', detail: 'Up from SGD 1.00.' });
    expect(pair(100, 0)?.detail).toBe('Balance unchanged.');
  });
  it('keeps larger-group summaries compact without implying a counterparty', () => {
    expect(refundBalanceSummary(-100000, 'SGD')).toBe('owes SGD 1,000.00');
    expect(refundBalanceSummary(100, 'EUR')).toBe('owed EUR 1.00');
    expect(refundBalanceSummary(0, 'USD')).toBe('settled up (USD)');
    expect(refundBalanceSummary(Number.MAX_SAFE_INTEGER, 'USD')).toBe('owed USD 90,071,992,547,409.91');
  });
  it('uses current outcomes for sign crossings and settled states', () => {
    expect(pair(-100, 200)).toEqual({ outcome: 'Alex will owe you SGD 1.00', detail: 'Currently, you owe Alex SGD 1.00.' });
    expect(pair(100, -200)?.detail).toBe('Currently, Alex owes you SGD 1.00.');
    expect(pair(-100, 100)?.outcome).toBe('You and Alex will be settled up');
    expect(pair(0, -100)?.detail).toBe('Currently, you and Alex are settled up.');
  });
  it('requires the entire group and complete opposite raw balances, not just two affected people', () => {
    expect(pair(-100, 10, ['me', 'alex', 'removed-person'])).toBeUndefined();
    expect(refundPairOutcome(['me', 'alex'], undefined, 'me', String, 'SGD', () => 0)).toBeUndefined();
    expect(refundPairOutcome(['me', 'alex'], raw(100).slice(0, 1), 'me', String, 'SGD', () => 0)).toBeUndefined();
    expect(refundPairOutcome(['me', 'alex'], [raw(100)[0], { ...raw(100)[1], netMinor: 50 }], 'me', String, 'SGD', () => 0)).toBeUndefined();
    expect(refundPairOutcome(['me', 'alex'], raw(100), 'me', String, 'SGD', () => 100)).toBeUndefined();
    expect(refundPairOutcome(['me', 'alex'], [...raw(100), { ...raw(100)[0], personId: 'historical' }], 'me', String, 'SGD', () => 0)).toBeUndefined();
    // An unrelated member actually named You remains the other person.
    expect(refundPairOutcome(['me', 'alex'], raw(100), 'me', () => 'You', 'SGD', () => 0)?.outcome).toBe('You will owe you SGD 1.00');
  });
  it.each([[-500, 1000, 500], [500, -1000, -500], [-500, 500, 0], [0, -100, -100], [0, 100, 100]])('projects sign and zero crossings (%i + %i)', (current, effect, result) => {
    expect(projectedRefundBalance(current, effect)).toBe(result);
  });
  it('replaces, rather than double-counts, saved effects on edits', () => {
    expect(projectedRefundBalance(-200, -600, -600)).toBe(-200);
    expect(projectedRefundBalance(-200, -300, -600)).toBe(100);
    // A currency change removes USD independently and adds EUR independently.
    expect(projectedRefundBalance(-200, 0, -600)).toBe(400);
    expect(projectedRefundBalance(100, -300, 0)).toBe(-200);
  });
  it('uses exact states and current-user grammar with currency labels', () => {
    expect(refundBalanceText('You', -200, 'USD', true)).toBe('You owe 2.00 USD');
    expect(refundBalanceText('You', 200, 'EUR', true)).toBe('You are owed 2.00 EUR');
    expect(refundBalanceText('Demo friend (removed)', 200, 'USD')).toBe('Demo friend (removed) is owed 2.00 USD');
    expect(refundBalanceText('Demo friend', -200, 'USD')).toBe('Demo friend owes 2.00 USD');
    expect(refundBalanceText('You', 0, 'USD', true)).toBe('You are settled up (USD)');
    expect(refundBalanceText('You', -200, 'USD', false)).toBe('You owes 2.00 USD');
    expect(refundBalanceText('You', 200, 'USD', false)).toBe('You is owed 2.00 USD');
    expect(refundBalanceText('You', 0, 'USD', false)).toBe('You is settled up (USD)');
  });
  it('uses saved allocations, including overlapping receipt and benefit, without expense reconstruction', () => {
    expect([...savedRefundEffects(credit)]).toEqual([['one', -600], ['two', 600]]);
    const markup = renderToStaticMarkup(<RefundRecordEffects credit={credit} label={(id) => id === 'one' ? 'You' : 'Demo friend'} />);
    expect(markup).toContain('Money received');
    expect(markup).toContain('Cost-share reduction');
    expect(markup).toContain('6.00 USD subtracted');
    expect(markup).not.toContain('After saving');
    expect([...savedRefundEffects({ ...credit, deletedAt: '2026-01-02' })]).toEqual([]);
    expect(renderToStaticMarkup(<RefundRecordEffects credit={{ ...credit, deletedAt: 'deleted' }} label={String} />)).toBe('');
  });
  it('keeps a linked saved snapshot independent of changed current expense splits', () => {
    const getExpense = vi.spyOn(api, 'getExpenseDetails').mockResolvedValue({ expense: { id: 'changed-expense', groupId: 'demo', description: 'Sample purchase', amountMinor: 1000, currency: 'USD', date: '2026-01-01', createdBy: 'demo', createdAt: '', updatedAt: '', version: 2, payers: [{ personId: 'two', amountMinor: 1000 }], splits: [{ personId: 'two', amountMinor: 1000 }] }, history: [] });
    try {
      const markup = renderToStaticMarkup(<RefundRecordEffects credit={{ ...credit, applications: [{ expenseId: 'changed-expense', amountMinor: 1000 }] }} label={String} />);
      expect(markup).toContain('6.00 USD subtracted');
      expect(markup).toContain('Cost-share reduction: 4.00 USD');
      expect(getExpense).not.toHaveBeenCalled();
    } finally { getExpense.mockRestore(); }
  });
  it('distinguishes provider payment reduction from receipt', () => {
    const markup = renderToStaticMarkup(<RefundRecordEffects credit={{ ...credit, deliveryMode: 'direct_provider_offset' }} label={String} />);
    expect(markup).toContain('Original payment reduction');
    expect(markup).not.toContain('Money received');
  });
  it('names only unambiguous conditional transfers, generalizes multiple parties and omits sole same person', () => {
    const label = (id: string) => id === 'one' ? 'You' : 'Demo friend';
    expect(refundTransferHelp(['one'], ['two'], label, 'one')).toContain('If you passed or later pass this money to Demo friend');
    expect(refundTransferHelp(['one'], ['two'], label, 'two')).toContain('If You passed or later passes this money to you');
    expect(refundTransferHelp(['one'], ['one'], label)).toBeUndefined();
    expect(refundTransferHelp(['one'], [], label)).toBeUndefined();
    expect(refundTransferHelp(['one', 'two'], ['two'], label)).toContain('If recipients pass money');
  });
});
