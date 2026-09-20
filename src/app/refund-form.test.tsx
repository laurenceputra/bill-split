import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Credit, Expense, GroupResponse } from '../shared/types';
import { AllocationRows, beneficiaryRowsComplete, beneficiarySnapshotMatches, buildRefundInput, createRefundOperationController, duplicateRefundAllocationTypes, groupRefundPreviewRows, initialRefundApplications, RefundCreateRoute, RefundExpensePickerOptions, RefundForm, refundAllocationPeople, refundAllocationRowsHavePositiveAmounts, refundAllocationDuplicateError, refundAllocationRowsForValidation, refundApplicationFillAmount, refundApplicationRowsHavePositiveAmounts, refundApplicationStatus, refundApplicationsForPath, refundBeneficiaryPreviewRows, refundErrorText, refundExpenseOptions, refundModeOptions, refundPreviewRows, refundSourceOptions, removeRefundAllocation } from './refund-form';
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

  it('fills only the current expense with the remaining entered refund', () => {
    const rows = [{ id: 'first', amount: '2.00' }, { id: 'second', amount: '1.00' }];
    expect(refundApplicationFillAmount(rows, 'first', 500, 400, 'USD')).toBe(400);
    expect(refundApplicationFillAmount(rows, 'first', 0, 400, 'USD')).toBe(400);
    expect(refundApplicationFillAmount([{ id: 'first', amount: '10.00' }, { id: 'second', amount: '' }], 'second', 1000, 500, 'USD')).toBe(0);
    expect(refundApplicationStatus(500, 300, 'USD').label).toBe('Remaining to apply: 2.00 USD');
    expect(refundApplicationStatus(500, 500, 'USD').label).toBe('Fully applied');
    expect(refundApplicationStatus(500, 650, 'USD').label).toBe('Overallocated by 1.50 USD');
  });

  it('rejects zero and invalid application or allocation rows before payload construction', () => {
    expect(refundApplicationRowsHavePositiveAmounts([{ amount: '1.00' }, { amount: '0.00' }], 'USD')).toBe(false);
    expect(refundApplicationRowsHavePositiveAmounts([{ amount: '1.00' }], 'USD')).toBe(true);
    expect(refundAllocationRowsHavePositiveAmounts([
      { id: 'recipient', personId: 'one', allocationType: 'recipient', amount: '1.00' },
      { id: 'beneficiary', personId: 'two', allocationType: 'beneficiary', amount: '0.00' },
    ], 'USD')).toBe(false);
    expect(refundAllocationRowsHavePositiveAmounts([
      { id: 'recipient', personId: 'one', allocationType: 'recipient', amount: '1.00' },
    ], 'USD')).toBe(true);
    expect(beneficiaryRowsComplete([{ id: 'beneficiary', personId: 'two', allocationType: 'beneficiary', amount: '0.00' }], 0, 'USD')).toBe(false);
  });

  it('ignores a blank standalone beneficiary retained when switching to linked mode', () => {
    const allocations = [
      { id: 'recipient', personId: 'one', allocationType: 'recipient' as const, amount: '1.00' },
      { id: 'beneficiary', personId: '', allocationType: 'beneficiary' as const, amount: '' },
      { id: 'hidden-beneficiary-1', personId: 'hidden', allocationType: 'beneficiary' as const, amount: '0.50' },
      { id: 'hidden-beneficiary-2', personId: 'hidden', allocationType: 'beneficiary' as const, amount: '0.50' },
    ];
    const relevant = refundAllocationRowsForValidation(allocations, 'member_reimbursement', true, false);
    expect(relevant).toEqual([allocations[0]]);
    expect(refundAllocationRowsHavePositiveAmounts(relevant, 'USD')).toBe(true);
    expect(refundAllocationDuplicateError(relevant)).toBeUndefined();
    expect(buildRefundInput({ subtype: 'refund', mode: 'member_reimbursement', amountMinor: 100, currency: 'USD', date: '2026-01-01', note: '', linked: true, adjustBenefits: false, applications: [{ expenseId: 'expense-1', amountMinor: 100 }], allocations }).allocations).toEqual([
      { person_id: 'one', allocation_type: 'recipient', amount_minor: 100 },
    ]);
  });

  it.each([
    {
      name: 'linked member reimbursement with derived benefits',
      mode: 'member_reimbursement' as const,
      linked: true,
      adjustBenefits: false,
      rows: [
        { id: 'recipient', personId: 'recipient', allocationType: 'recipient' as const, amount: '1.00' },
        { id: 'retained-beneficiary', personId: 'removed', allocationType: 'beneficiary' as const, amount: '' },
      ],
      relevantIds: ['recipient'],
      submitted: [{ person_id: 'recipient', allocation_type: 'recipient' as const, amount_minor: 100 }],
      valid: true,
    },
    {
      name: 'linked member reimbursement with adjusted benefits',
      mode: 'member_reimbursement' as const,
      linked: true,
      adjustBenefits: true,
      rows: [
        { id: 'recipient', personId: 'recipient', allocationType: 'recipient' as const, amount: '1.00' },
        { id: 'beneficiary', personId: 'beneficiary', allocationType: 'beneficiary' as const, amount: '1.00' },
      ],
      relevantIds: ['recipient', 'beneficiary'],
      submitted: [
        { person_id: 'recipient', allocation_type: 'recipient' as const, amount_minor: 100 },
        { person_id: 'beneficiary', allocation_type: 'beneficiary' as const, amount_minor: 100 },
      ],
      valid: true,
    },
    {
      name: 'standalone member reimbursement',
      mode: 'member_reimbursement' as const,
      linked: false,
      adjustBenefits: false,
      rows: [
        { id: 'recipient', personId: 'recipient', allocationType: 'recipient' as const, amount: '1.00' },
        { id: 'beneficiary', personId: 'beneficiary', allocationType: 'beneficiary' as const, amount: '1.00' },
      ],
      relevantIds: ['recipient', 'beneficiary'],
      submitted: [
        { person_id: 'recipient', allocation_type: 'recipient' as const, amount_minor: 100 },
        { person_id: 'beneficiary', allocation_type: 'beneficiary' as const, amount_minor: 100 },
      ],
      valid: true,
    },
    {
      name: 'linked direct-provider adjustment with stale retained allocations',
      mode: 'direct_provider_offset' as const,
      linked: true,
      adjustBenefits: false,
      rows: [
        { id: 'stale-recipient', personId: 'removed', allocationType: 'recipient' as const, amount: '' },
        { id: 'stale-beneficiary', personId: 'removed', allocationType: 'beneficiary' as const, amount: '' },
        { id: 'duplicate-stale-beneficiary', personId: 'removed', allocationType: 'beneficiary' as const, amount: 'not-money' },
      ],
      relevantIds: [],
      submitted: [],
      valid: true,
    },
  ])('keeps $name filtering, local validation, and payload construction aligned', ({ mode, linked, adjustBenefits, rows, relevantIds, submitted, valid }) => {
    const relevant = refundAllocationRowsForValidation(rows, mode, linked, adjustBenefits);
    const input = buildRefundInput({ subtype: 'refund', mode, amountMinor: 100, currency: 'USD', date: '2026-01-01', note: '', linked, adjustBenefits, applications: [{ expenseId: 'expense-1', amountMinor: 100 }], allocations: rows });

    expect(relevant.map((row) => row.id)).toEqual(relevantIds);
    expect(input.allocations).toEqual(submitted);
    expect(refundAllocationRowsHavePositiveAmounts(relevant, 'USD')).toBe(valid);
    expect(refundAllocationDuplicateError(relevant)).toBeUndefined();
  });

  it.each([
    {
      name: 'the recipient in a linked derived-benefit reimbursement',
      mode: 'member_reimbursement' as const,
      linked: true,
      adjustBenefits: false,
      rows: [{ id: 'recipient', personId: '', allocationType: 'recipient' as const, amount: '' }],
    },
    {
      name: 'an adjusted linked beneficiary',
      mode: 'member_reimbursement' as const,
      linked: true,
      adjustBenefits: true,
      rows: [{ id: 'beneficiary', personId: 'beneficiary', allocationType: 'beneficiary' as const, amount: '' }],
    },
    {
      name: 'a standalone beneficiary',
      mode: 'member_reimbursement' as const,
      linked: false,
      adjustBenefits: false,
      rows: [{ id: 'beneficiary', personId: 'beneficiary', allocationType: 'beneficiary' as const, amount: '0.00' }],
    },
  ])('blocks an incomplete required $name', ({ mode, linked, adjustBenefits, rows }) => {
    const relevant = refundAllocationRowsForValidation(rows, mode, linked, adjustBenefits);
    expect(relevant).toHaveLength(1);
    expect(refundAllocationRowsHavePositiveAmounts(relevant, 'USD')).toBe(false);
  });

  it('uses plain-language source and handling choices and disables impossible standalone handling', () => {
    expect(refundSourceOptions.map((option) => option.label)).toEqual(['Merchant refund', 'Reimbursement or claim']);
    expect(refundModeOptions(false).find((option) => option.value === 'direct_provider_offset')?.disabled).toBe(true);
    expect(refundModeOptions(true).find((option) => option.value === 'direct_provider_offset')?.disabled).toBe(false);
  });

  it('uses exact user-facing duplicate messages for each allocation side', () => {
    expect(duplicateRefundAllocationTypes([
      { personId: 'one', allocationType: 'recipient' },
      { personId: 'one', allocationType: 'recipient' },
      { personId: 'one', allocationType: 'beneficiary' },
      { personId: 'two', allocationType: 'beneficiary' },
    ])).toEqual(['recipient']);
    expect(refundAllocationDuplicateError([
      { personId: 'one', allocationType: 'recipient' },
      { personId: 'one', allocationType: 'recipient' },
    ])).toBe('Choose each person only once within recipient allocations.');
    expect(refundAllocationDuplicateError([
      { personId: 'one', allocationType: 'beneficiary' },
      { personId: 'one', allocationType: 'beneficiary' },
    ])).toBe('Choose each person only once within affected-member allocations.');
    expect(refundAllocationDuplicateError([
      { personId: 'one', allocationType: 'recipient' },
      { personId: 'one', allocationType: 'recipient' },
      { personId: 'two', allocationType: 'beneficiary' },
      { personId: 'two', allocationType: 'beneficiary' },
    ])).toBe('Choose each person only once within recipient allocations and within affected-member allocations. The same person may be selected once on each side.');
    expect(refundAllocationDuplicateError([
      { personId: 'one', allocationType: 'recipient' },
      { personId: 'one', allocationType: 'beneficiary' },
    ])).toBeUndefined();
    const markup = renderToStaticMarkup(<AllocationRows
      rows={[{ id: 'recipient-1', personId: 'one', allocationType: 'recipient', amount: '1.00' }, { id: 'recipient-2', personId: '', allocationType: 'recipient', amount: '' }]}
      label="Recipient" currency="USD" people={[{ personId: 'one', name: 'One' }, { personId: 'two', name: 'Two' }]}
      onChange={() => undefined} onRemove={() => undefined} minimumRows={1} showErrors={false}
    />);
    expect(markup).toContain('class="field refund-allocation-row__person"');
    expect(markup).toContain('class="field refund-allocation-row__amount"');
    expect(markup).toContain('refund-allocation-row__remove');
    expect(markup).toContain('aria-label="Recipient 1"');
    expect(markup).toContain('aria-label="Recipient amount 1 (USD)"');
    expect(markup).toContain('aria-label="Remove recipient allocation 2"');
    expect(markup).toContain('value="two"');
    const allocationRows = markup.split('<div class="allocation-row refund-allocation-row">').slice(1);
    expect(allocationRows).toHaveLength(2);
    expect(allocationRows[0]).toMatch(/<option\b[^>]*value="one"[^>]*>One<\/option>/);
    expect(allocationRows[1]).not.toMatch(/<option\b[^>]*value="one"[^>]*>One<\/option>/);
    expect(allocationRows[0]).toMatch(/<option\b[^>]*value="two"[^>]*>Two<\/option>/);
    expect(allocationRows[1]).toMatch(/<option\b[^>]*value="two"[^>]*>Two<\/option>/);
  });

  it('groups cross-side preview components by person and preserves signed effects', () => {
    expect(groupRefundPreviewRows([
      { personId: 'one', label: 'Received', amountMinor: -100 },
      { personId: 'one', label: 'Cost reduction', amountMinor: 40 },
      { personId: 'two', label: 'Cost reduction', amountMinor: 60 },
    ])).toEqual([
      { personId: 'one', components: [{ label: 'Received', amountMinor: -100 }, { label: 'Cost reduction', amountMinor: 40 }], netMinor: -60 },
      { personId: 'two', components: [{ label: 'Cost reduction', amountMinor: 60 }], netMinor: 60 },
    ]);
  });

  it('uses signed direct-provider components so the same payer and beneficiary net to zero', () => {
    expect(groupRefundPreviewRows(refundPreviewRows(
      'direct_provider_offset',
      [],
      [{ personId: 'one', amountMinor: 100 }],
      [{ personId: 'one', amountMinor: 100 }],
      [],
      'USD',
    ))).toEqual([{
      personId: 'one',
      components: [{ label: 'Payment reduction', amountMinor: -100 }, { label: 'Cost reduction', amountMinor: 100 }],
      netMinor: 0,
    }]);
  });

  it('omits blank person IDs from the money-flow preview', () => {
    expect(groupRefundPreviewRows([
      { personId: '', label: 'Received', amountMinor: -100 },
      { personId: '  ', label: 'Cost reduction', amountMinor: 100 },
      { personId: 'one', label: 'Cost reduction', amountMinor: 100 },
    ])).toEqual([{ personId: 'one', components: [{ label: 'Cost reduction', amountMinor: 100 }], netMinor: 100 }]);
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

  it('renders one shared allocation validation error after multiple rows', () => {
    const markup = renderToStaticMarkup(<AllocationRows
      rows={[
        { id: 'recipient-1', personId: 'person-1', allocationType: 'recipient', amount: '0.25' },
        { id: 'recipient-2', personId: 'person-2', allocationType: 'recipient', amount: '0.25' },
      ]}
      label="Recipient"
      currency="USD"
      people={[{ personId: 'person-1', name: 'One' }, { personId: 'person-2', name: 'Two' }]}
      onChange={() => undefined}
      onRemove={() => undefined}
      minimumRows={1}
      showErrors
      error="Recipient amounts must total the refund."
    />);
    expect((markup.match(/role="alert"/g) || []).length).toBe(1);
    const lastAllocationRow = markup.lastIndexOf('class="allocation-row refund-allocation-row"');
    expect(lastAllocationRow).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('Recipient amounts must total the refund.')).toBeGreaterThan(lastAllocationRow);
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
