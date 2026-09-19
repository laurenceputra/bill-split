import { describe, expect, it } from 'vitest';
import { selectCreditFormRetryKey, validateCreditDraft, type CreditAllocationDraft, type CreditApplicationDraft } from './credit-form';

const application = (id: string, expenseId: string, amount = '10'): CreditApplicationDraft => ({ id, expenseId, amount });
const allocation = (id: string, personId: string, allocationType: CreditAllocationDraft['allocationType'], amount = '10'): CreditAllocationDraft => ({ id, personId, allocationType, amount });

describe('credit form resource retry target', () => {
  const keys = { identity: 'identity-key', group: 'group-key', expenses: 'expenses-key' };

  it('selects the failed resource with identity precedence and expense precedence over group', () => {
    expect(selectCreditFormRetryKey({ expenses: new Error('expenses') }, keys)).toBe(keys.expenses);
    expect(selectCreditFormRetryKey({ group: new Error('group'), expenses: new Error('expenses') }, keys)).toBe(keys.expenses);
    expect(selectCreditFormRetryKey({ identity: new Error('identity'), group: new Error('group'), expenses: new Error('expenses') }, keys)).toBe(keys.identity);
    expect(selectCreditFormRetryKey({}, keys)).toBeUndefined();
  });
});

describe('credit form draft validation', () => {
  it('requires every visible application row and rejects duplicate expenses', () => {
    expect(validateCreditDraft([application('a', 'expense-a'), application('b', '')], [], 'direct_provider_offset')).toContain('Complete');
    expect(validateCreditDraft([application('a', 'expense-a'), application('b', 'expense-a')], [], 'direct_provider_offset')).toContain('only once');
  });

  it('accepts complete multi-application rows and catches duplicate allocation sides', () => {
    expect(validateCreditDraft([application('a', 'expense-a'), application('b', 'expense-b')], [], 'direct_provider_offset')).toBeUndefined();
    expect(validateCreditDraft([], [allocation('a', 'person-a', 'recipient'), allocation('b', 'person-a', 'recipient')], 'member_reimbursement')).toContain('allocation side');
  });
});
