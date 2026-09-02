import { describe, expect, it } from 'vitest';
import { allocationMetadataByPerson, allocationSplits, allocationStateFromSplits, amountFieldClass, amountInputClass, amountInputLength, currentPayerSelection, formServerVersion, groupSplitDefaultFromDraft, groupSplitDefaultSummary, hasNewerServerVersion, isCurrentSplitDefaultSave, isExpenseConflict, normalizeExpenseSplitArrangement, normalizeSinglePayer, previewAllocation, resolveGroupSplitDefault, sameGroupSplitArrangement, settlementSuggestion, settlementSuggestionFingerprint, type FormSaveFence } from './form-helpers';
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
  it('falls back to equal for defaults containing a removed member', () => {
    const value = { method: 'percentage' as const, personIds: ['one', 'gone'], values: [5000, 5000] };
    expect(resolveGroupSplitDefault(value, members)).toMatchObject({ method: 'equal', selected: ['one', 'two'], applied: false, invalid: true });
    expect(groupSplitDefaultSummary(value, members)).toMatchObject({ warning: true });
  });

  it('normalizes arrangements by deterministic member order and compares allocations', () => {
    const namedMembers = [member('two', 'Zed'), member('one', 'Amy')];
    const percentage = normalizeExpenseSplitArrangement([
      { personId: 'two', metadata: { method: 'percentage', value: 7500 } },
      { personId: 'one', metadata: { method: 'percentage', value: 2500 } },
    ], namedMembers);
    expect(percentage).toEqual({ method: 'percentage', personIds: ['one', 'two'], values: [2500, 7500] });
    expect(sameGroupSplitArrangement(percentage, { method: 'percentage', personIds: ['one', 'two'], values: [2500, 7500] }, namedMembers)).toBe(true);
    expect(normalizeExpenseSplitArrangement([{ personId: 'one', metadata: { method: 'exact', value: 100 } }], namedMembers)).toBeNull();
    expect(normalizeExpenseSplitArrangement([{ personId: 'one', metadata: { method: 'percentage', value: 5000 } }, { personId: 'two', metadata: { method: 'percentage', value: 4000 } }], namedMembers)).toBeNull();
    expect(groupSplitDefaultFromDraft('exact', ['one'], { one: '1.00' }, namedMembers)).toMatchObject({ value: null, reason: 'exact' });
    expect(groupSplitDefaultFromDraft('shares', ['one', 'two'], { one: '1', two: '2' }, namedMembers).value).toEqual({ method: 'shares', personIds: ['one', 'two'], values: [1, 2] });
    expect(sameGroupSplitArrangement({ method: 'shares', personIds: ['one', 'two'], values: [1, 2] }, { method: 'shares', personIds: ['one', 'two'], values: [2, 4] }, namedMembers)).toBe(false);
  });

  it('uses strict expense allocation parsing when deriving saveable defaults', () => {
    expect(groupSplitDefaultFromDraft('percentage', ['one', 'two'], { one: '33.336', two: '66.664' }, members)).toMatchObject({ value: null, reason: 'invalid' });
    expect(groupSplitDefaultFromDraft('percentage', ['one', 'two'], { one: '33.33', two: '66.67' }, members).value).toEqual({ method: 'percentage', personIds: ['one', 'two'], values: [3333, 6667] });
    for (const values of [{ one: '', two: '1' }, { one: '0', two: '1' }, { one: '1e2', two: '1' }, { one: '1000001', two: '1' }]) {
      expect(groupSplitDefaultFromDraft('shares', ['one', 'two'], values, members)).toMatchObject({ value: null, reason: 'invalid' });
      expect(previewAllocation(1000, ['one', 'two'], 'shares', values, 'USD').error).toBeTruthy();
    }
  });

  it('rejects a stale default response after an A-to-B-to-A route switch', () => {
    const captured: FormSaveFence = { token: 1, scope: 'user:group-a:expense:new', sessionGeneration: 4 };
    const current: FormSaveFence = { token: 3, scope: 'user:group-a:expense:new', sessionGeneration: 4 };
    expect(isCurrentSplitDefaultSave(captured, current)).toBe(false);
    expect(isCurrentSplitDefaultSave(captured, { ...current, token: captured.token })).toBe(true);
    expect(isCurrentSplitDefaultSave(captured, { ...current, token: captured.token, sessionGeneration: 5 })).toBe(false);
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

  it('compares the scheduled record version while editing a schedule', () => {
    expect(formServerVersion(true, undefined, 4)).toBe(4);
    expect(hasNewerServerVersion(3, formServerVersion(true, undefined, 4), true)).toBe(true);
    expect(formServerVersion(false, 4, 9)).toBe(4);
  });

  it('fingerprints settlement suggestions for safe refreshes', () => {
    const suggestion = { fromPersonId: 'one', fromName: 'One', toPersonId: 'two', toName: 'Two', amountMinor: 900, currency: 'USD' as const };
    expect(settlementSuggestionFingerprint(suggestion, 'USD')).toBe('USD:one:two:900');
    expect(settlementSuggestionFingerprint({ ...suggestion, amountMinor: 901 }, 'USD')).not.toBe(settlementSuggestionFingerprint(suggestion, 'USD'));
    expect(settlementSuggestionFingerprint(undefined, 'USD', 'one', 'two')).toBe('USD:one:two:');
  });
});
