import { describe, expect, it } from 'vitest';
import { allocationMetadataByPerson, allocationSplits, allocationStateFromSplits, amountFieldClass, amountInputClass, amountInputLength, currentPayerSelection, hasNewerServerVersion, isExpenseConflict, normalizeSinglePayer, previewAllocation, settlementSuggestion, settlementSuggestionFingerprint } from './form-helpers';
import type { Balances, GroupMember } from '../shared/types';

const member = (personId: string, name = personId): GroupMember => ({ personId, name, joinedAt: '', role: 'member' });
const members = [member('one', 'One'), member('two', 'Two')];

describe('expense form helpers', () => {
  it('prefers the authenticated member as the payer', () => {
    expect(currentPayerSelection('two', members)).toBe('two');
    expect(currentPayerSelection('missing', members)).toBe('one');
    expect(normalizeSinglePayer([{ personId: 'two', amount: '12.00' }, { personId: 'one', amount: '8.00' }].slice(0, 1), '20.00')).toEqual([{ personId: 'two', amount: '20.00' }]);
  });

  it('maps keyed allocation state and preserves method metadata', () => {
    const splits = [{ personId: 'one', amountMinor: 2500, metadata: { method: 'percentage', value: 5000 } }, { personId: 'two', amountMinor: 2500, metadata: { method: 'percentage', value: 5000 } }];
    const state = allocationStateFromSplits(splits, 'percentage');
    expect(state).toEqual({ one: '50', two: '50' });
    const preview = previewAllocation(5000, ['one', 'two'], 'percentage', state, 'USD');
    const metadata = allocationMetadataByPerson([{ personId: 'one', amountMinor: 2500, metadata: { method: 'percentage', value: 5000, source: 'receipt' } }, ...splits.slice(1)]);
    expect(allocationSplits(['one', 'two'], 'percentage', preview, state, metadata)).toEqual([
      { person_id: 'one', amount_minor: 2500, metadata: { method: 'percentage', value: 5000, source: 'receipt' } },
      { person_id: 'two', amount_minor: 2500, metadata: { method: 'percentage', value: 5000 } },
    ]);
  });

  it('rejects unsafe percentage and share calculations without unsafe allocations', () => {
    const percentage = previewAllocation(1000, ['one', 'two'], 'percentage', { one: '50.005', two: '49.995' }, 'USD');
    expect(percentage.error).toContain('up to two decimals');
    expect(percentage.allocations).toEqual({});
    const shares = previewAllocation(Number.MAX_SAFE_INTEGER, ['one', 'two'], 'shares', { one: '1000000', two: '1' }, 'USD');
    expect(shares.error).toContain('safe amount calculation');
    expect(Object.values(shares.allocations).every(Number.isSafeInteger)).toBe(true);
  });
});

describe('settlement suggestion', () => {
  const balances: Record<string, Balances> = {
    USD: { raw: [], simplified: [
      { fromPersonId: 'one', fromName: 'One', toPersonId: 'two', toName: 'Two', amountMinor: 900, currency: 'USD' },
      { fromPersonId: 'three', fromName: 'Three', toPersonId: 'four', toName: 'Four', amountMinor: 100, currency: 'USD' },
    ] },
  };

  it('prefers a debt involving the current person and keeps debtor direction', () => {
    expect(settlementSuggestion(balances, 'two', 'USD')).toMatchObject({ fromPersonId: 'one', toPersonId: 'two', amountMinor: 900 });
    expect(settlementSuggestion(balances, 'missing', 'USD')).toMatchObject({ fromPersonId: 'one', toPersonId: 'two' });
  });
});

describe('financial form presentation helpers', () => {
  it('adds length-aware amount classes without changing the value', () => {
    expect(amountInputLength('0.00')).toBe('normal');
    expect(amountInputLength('104.00')).toBe('normal');
    expect(amountInputLength('999999.99')).toBe('normal');
    expect(amountInputLength('123456789.01')).toBe('long');
    expect(amountInputLength('1234567890.00')).toBe('long');
    expect(amountInputClass('90071992547409.91')).toBe('amount-input amount-input--very-long');
    expect(amountFieldClass('90071992547409.91')).toBe('amount-field amount-field--very-long');
  });

  it('only warns about a newer server version for dirty forms', () => {
    expect(hasNewerServerVersion(3, 4, true)).toBe(true);
    expect(hasNewerServerVersion(3, 3, true)).toBe(false);
    expect(hasNewerServerVersion(3, 4, false)).toBe(false);
    expect(isExpenseConflict(409, undefined)).toBe(true);
    expect(isExpenseConflict(400, 'CONFLICT')).toBe(true);
    expect(isExpenseConflict(400, 'VALIDATION_ERROR')).toBe(false);
  });

  it('fingerprints settlement suggestions for safe refreshes', () => {
    const suggestion = { fromPersonId: 'one', fromName: 'One', toPersonId: 'two', toName: 'Two', amountMinor: 900, currency: 'USD' as const };
    expect(settlementSuggestionFingerprint(suggestion, 'USD')).toBe('USD:one:two:900');
    expect(settlementSuggestionFingerprint({ ...suggestion, amountMinor: 901 }, 'USD')).not.toBe(settlementSuggestionFingerprint(suggestion, 'USD'));
    expect(settlementSuggestionFingerprint(undefined, 'USD', 'one', 'two')).toBe('USD:one:two:');
  });
});
