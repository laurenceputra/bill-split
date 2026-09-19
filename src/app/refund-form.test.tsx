import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Credit, Expense, GroupResponse } from '../shared/types';
import { beneficiaryRowsComplete, beneficiarySnapshotMatches, buildRefundInput, createRefundOperationController, initialRefundApplications, RefundCreateRoute, RefundExpensePickerOptions, RefundForm, refundAllocationPeople, refundApplicationsForPath, refundBeneficiaryPreviewRows, refundErrorText, refundExpenseOptions, removeRefundAllocation } from './refund-form';
import { ApiError } from './api';
import { resourceKeys, seedResource } from './resource-cache';

const expense = (id: string, currency: Expense['currency']): Expense => ({ id, groupId: 'group', description: id, amountMinor: 1000, currency, date: '2026-01-01', createdBy: 'user', createdAt: '', updatedAt: '', version: 1, payers: [], splits: [] });
afterEach(() => vi.unstubAllGlobals());

describe('refund expense picker behavior', () => {
  it('lets the first row choose every currency and later rows choose every unselected expense in the locked currency', () => {
    const rows = [{ id: 'first', expenseId: 'usd' }, { id: 'second', expenseId: '' }];
    expect(refundExpenseOptions([expense('usd', 'USD'), expense('eur', 'EUR'), expense('usd-two', 'USD')], rows, 'first').map((item) => item.id)).toEqual(['usd', 'eur', 'usd-two']);
    expect(refundExpenseOptions([expense('usd', 'USD'), expense('eur', 'EUR'), expense('usd-two', 'USD')], rows, 'second').map((item) => item.id)).toEqual(['usd-two']);
    expect(renderToStaticMarkup(<select><RefundExpensePickerOptions expenses={[expense('usd', 'USD'), expense('eur', 'EUR')]} rows={[{ id: 'first', expenseId: '' }]} rowId="first" /></select>)).toContain('EUR');
  });

  it('keeps the create operation id stable across retries and rotates only after lifecycle completion', () => {
    const ids = ['first', 'second', 'third'];
    const controller = createRefundOperationController(() => ids.shift() || 'fallback');
    expect(controller.current()).toBe('first');
    expect(controller.current()).toBe('first');
    controller.rotateAfterSuccess();
    expect(controller.current()).toBe('second');
    controller.rotateAfterUnmount();
    expect(controller.current()).toBe('third');
  });

  it('starts new forms linked and only enforces minimum allocation rows where required', () => {
    expect(initialRefundApplications().every((row) => !row.expenseId)).toBe(true);
    const recipient = { id: 'r', personId: 'a', allocationType: 'recipient' as const, amount: '1' };
    const affected = { id: 'b', personId: 'b', allocationType: 'beneficiary' as const, amount: '1' };
    expect(removeRefundAllocation([recipient], 'r', 1)).toHaveLength(1);
    expect(removeRefundAllocation([recipient, affected], 'r', 1)).toEqual([affected]);
    expect(removeRefundAllocation([affected], 'b', 0)).toEqual([]);
    expect(refundApplicationsForPath('standalone', initialRefundApplications())).toEqual([]);
    expect(refundApplicationsForPath('linked', [])).toHaveLength(1);
  });

  it('builds linked member payloads that let the server derive untouched beneficiaries', () => {
    const input = buildRefundInput({ subtype: 'refund', mode: 'member_reimbursement', amountMinor: 100, currency: 'USD', date: '2026-01-01', note: '', linked: true, adjustBenefits: false, applications: [{ expenseId: 'expense-1', amountMinor: 100 }], allocations: [{ id: 'recipient', personId: 'person-a', allocationType: 'recipient', amount: '1.00' }, { id: 'beneficiary', personId: 'person-b', allocationType: 'beneficiary', amount: '1.00' }] });
    expect(input.allocations).toEqual([{ person_id: 'person-a', allocation_type: 'recipient', amount_minor: 100 }]);
    expect(beneficiarySnapshotMatches([{ id: 'beneficiary', personId: 'person-b', allocationType: 'beneficiary', amount: '1.00' }], [{ personId: 'person-b', amountMinor: 100 }], 'USD')).toBe(true);
    expect(beneficiarySnapshotMatches([{ id: 'beneficiary', personId: 'person-b', allocationType: 'beneficiary', amount: '0.99' }], [{ personId: 'person-b', amountMinor: 100 }], 'USD')).toBe(false);
    expect(buildRefundInput({ subtype: 'refund', mode: 'member_reimbursement', amountMinor: 100, currency: 'USD', date: '2026-01-01', note: 'Receipt', linked: true, adjustBenefits: true, applications: [{ expenseId: 'expense-1', amountMinor: 100 }], allocations: [{ id: 'recipient', personId: 'person-a', allocationType: 'recipient', amount: '1.00' }, { id: 'beneficiary', personId: 'person-b', allocationType: 'beneficiary', amount: '1.00' }] }).allocations).toHaveLength(2);
    const customRows = [{ id: 'beneficiary', personId: 'person-b', allocationType: 'beneficiary' as const, amount: '0.75' }, { id: 'beneficiary-2', personId: 'person-c', allocationType: 'beneficiary' as const, amount: '0.25' }];
    const preview = refundBeneficiaryPreviewRows(customRows, [{ personId: 'person-a', amountMinor: 100 }], true, true, 'USD');
    const persisted = buildRefundInput({ subtype: 'refund', mode: 'member_reimbursement', amountMinor: 100, currency: 'USD', date: '2026-01-01', note: '', linked: true, adjustBenefits: true, applications: [{ expenseId: 'expense-1', amountMinor: 100 }], allocations: [{ id: 'recipient', personId: 'person-a', allocationType: 'recipient', amount: '1.00' }, ...customRows] }).allocations.filter((allocation) => allocation.allocation_type === 'beneficiary').map((allocation) => ({ personId: allocation.person_id, amountMinor: allocation.amount_minor }));
    expect(preview).toEqual(persisted);
    expect(beneficiaryRowsComplete([], 100, 'USD')).toBe(false);
    expect(beneficiaryRowsComplete(customRows, 100, 'USD')).toBe(true);
    expect(buildRefundInput({ subtype: 'refund', mode: 'direct_provider_offset', amountMinor: 100, currency: 'USD', date: '2026-01-01', note: '', linked: true, adjustBenefits: false, applications: [{ expenseId: 'expense-1', amountMinor: 100 }], allocations: [] }).allocations).toEqual([]);
  });

  it('keeps server mutation errors visible as actionable form errors', () => {
    expect(refundErrorText(new ApiError('The linked expense changed; reload and retry.', { status: 409, code: 'CONFLICT' }))).toContain('linked expense changed');
    expect(refundErrorText(new Error('invalid recipient'))).toBe('invalid recipient');
  });

  it('renders the routed form loading state without requiring a browser viewport', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '' } });
    const markup = renderToStaticMarkup(<MemoryRouter initialEntries={['/groups/group-1/refund/new']}><Routes><Route path="/groups/:id/refund/new" element={<RefundCreateRoute />} /></Routes></MemoryRouter>);
    expect(markup).toContain('Loading');
  });

  it('offers active allocation members for creation and only retained inactive snapshots for edits', () => {
    const group = {
      members: [{ personId: 'active', name: 'Active', joinedAt: '', role: 'member' as const }],
      historicalParticipants: [
        { personId: 'active', name: 'Active', joinedAt: '', role: 'member' as const, status: 'active' as const },
        { personId: 'removed', name: 'Former', joinedAt: '', role: 'member' as const, status: 'removed' as const },
        { personId: 'deleted', name: 'Gone', joinedAt: '', role: 'member' as const, status: 'deleted' as const },
      ],
    };
    expect(refundAllocationPeople(group).map((person) => person.personId)).toEqual(['active']);
    expect(refundAllocationPeople(group, { allocations: [{ personId: 'removed', allocationType: 'beneficiary', amountMinor: 25 }] })).toEqual([
      { personId: 'active', name: 'Active' },
      { personId: 'removed', name: 'Former · Removed' },
    ]);
  });

  it('seeds an edit atomically before new-form effects and preserves the snapshot through a note edit', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    const testNavigator = { onLine: true, userAgent: 'test', platform: 'Linux', maxTouchPoints: 0, standalone: false };
    vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '' }, navigator: testNavigator, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true });
    vi.stubGlobal('navigator', testNavigator);
    const userId = 'lifecycle-user';
    const groupId = 'lifecycle-group';
    const creditId = 'lifecycle-credit';
    const expenseId = 'lifecycle-expense';
    const group: GroupResponse = {
      group: { id: groupId, name: 'Lifecycle group', currency: 'USD', createdAt: '', updatedAt: '' },
      members: [{ personId: 'recipient', name: 'Recipient', joinedAt: '', role: 'owner' }, { personId: 'active', name: 'Active', joinedAt: '', role: 'member' }],
      historicalParticipants: [
        { personId: 'recipient', name: 'Recipient', joinedAt: '', role: 'owner', status: 'active' },
        { personId: 'active', name: 'Active', joinedAt: '', role: 'member', status: 'active' },
        { personId: 'custom', name: 'Former custom', joinedAt: '', role: 'member', status: 'removed' },
      ],
      splitDefault: null,
      currentPersonId: 'recipient',
    };
    const linkedExpense: Expense = { id: expenseId, groupId, description: 'Dinner', amountMinor: 100, currency: 'USD', date: '2026-01-01', createdBy: userId, createdAt: '', updatedAt: '', version: 1, payers: [{ personId: 'recipient', amountMinor: 100 }], splits: [{ personId: 'active', amountMinor: 100 }] };
    const credit: Credit = { id: creditId, groupId, subtype: 'refund', deliveryMode: 'member_reimbursement', amountMinor: 100, currency: 'USD', date: '2026-01-02', note: 'Original note', createdBy: userId, createdAt: '', updatedAt: '', version: 2, applications: [{ expenseId, amountMinor: 100 }], allocations: [{ personId: 'recipient', allocationType: 'recipient', amountMinor: 100 }, { personId: 'custom', allocationType: 'beneficiary', amountMinor: 60 }, { personId: 'active', allocationType: 'beneficiary', amountMinor: 40 }] };
    seedResource(resourceKeys.identity(), 'identity', { id: userId, email: 'lifecycle@example.com', personId: 'recipient', name: 'Recipient' });
    seedResource(resourceKeys.group(userId, groupId), userId, group);
    seedResource(resourceKeys.creditDetail(userId, creditId), userId, { credit });
    seedResource(resourceKeys.expenses(userId, groupId), userId, { expenses: [linkedExpense] });

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<MemoryRouter initialEntries={[`/groups/${groupId}/refund/${creditId}/edit`]}><Routes><Route path="/groups/:id/refund/:creditId/edit" element={<RefundForm initialCredit={credit} />} /></Routes></MemoryRouter>);
      await Promise.resolve();
    });
    const fields = () => ({
      selects: renderer.root.findAllByType('select').map((node) => node.props.value),
      inputs: renderer.root.findAllByType('input').map((node) => node.props.value),
      note: renderer.root.findByType('textarea').props.value,
    });
    const before = fields();
    expect(before.selects).toContain('lifecycle-expense');
    expect(before.selects).toContain('custom');
    expect(before.inputs).toContain('0.60');
    expect(before.inputs).toContain('0.40');
    await act(async () => { renderer.root.findByType('textarea').props.onChange({ target: { value: 'Updated note' } }); });
    const after = fields();
    expect(after.note).toBe('Updated note');
    expect(after.selects).toEqual(before.selects);
    expect(after.inputs).toEqual(before.inputs);
    renderer.unmount();
  });
});
