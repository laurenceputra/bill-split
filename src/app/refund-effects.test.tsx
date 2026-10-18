import { describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Credit } from '../shared/types';
import { projectedRefundBalance, refundBalanceText, refundTransferHelp, savedRefundEffects } from './refund-effects';
import { RefundRecordEffects } from './refund-record-effects';

const credit: Credit = { id: 'refund', groupId: 'demo', subtype: 'refund', deliveryMode: 'member_reimbursement', amountMinor: 1000, currency: 'USD', date: '2026-01-01', createdBy: 'demo', createdAt: '', updatedAt: '', version: 1, applications: [], allocations: [
  { personId: 'one', allocationType: 'recipient', amountMinor: 1000 },
  { personId: 'one', allocationType: 'beneficiary', amountMinor: 400 },
  { personId: 'two', allocationType: 'beneficiary', amountMinor: 600 },
] };

describe('refund explanations', () => {
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
