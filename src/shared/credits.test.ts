import { describe, expect, it } from 'vitest';
import { creditInput } from './schemas';

const person = '00000000-0000-4000-8000-000000000001';
const expense = '00000000-0000-4000-8000-000000000002';

describe('credit input accounting invariants', () => {
  it('requires applications to consume the whole linked credit', () => {
    const result = creditInput.safeParse({
      subtype: 'refund', delivery_mode: 'direct_provider_offset', amount_minor: 100, currency: 'USD', date: '2026-01-01',
      applications: [{ expense_id: expense, amount_minor: 99 }], allocations: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a standalone reimbursement only when both signed sides balance', () => {
    const result = creditInput.safeParse({
      subtype: 'claim', delivery_mode: 'member_reimbursement', amount_minor: 100, currency: 'USD', date: '2026-01-01', applications: [],
      allocations: [
        { person_id: person, allocation_type: 'recipient', amount_minor: 100 },
        { person_id: person, allocation_type: 'beneficiary', amount_minor: 100 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects client allocations for direct-provider offsets', () => {
    const result = creditInput.safeParse({
      subtype: 'refund', delivery_mode: 'direct_provider_offset', amount_minor: 100, currency: 'USD', date: '2026-01-01',
      applications: [{ expense_id: expense, amount_minor: 100 }],
      allocations: [{ person_id: person, allocation_type: 'recipient', amount_minor: 100 }, { person_id: person, allocation_type: 'beneficiary', amount_minor: 100 }],
    });
    expect(result.success).toBe(false);
  });

  it('allows a linked member reimbursement to confirm the recipient while deriving affected shares', () => {
    const result = creditInput.safeParse({
      subtype: 'refund', delivery_mode: 'member_reimbursement', amount_minor: 100, currency: 'USD', date: '2026-01-01',
      applications: [{ expense_id: expense, amount_minor: 100 }],
      allocations: [{ person_id: person, allocation_type: 'recipient', amount_minor: 100 }],
    });
    expect(result.success).toBe(true);
  });

  it('requires a linked reimbursement recipient', () => {
    expect(creditInput.safeParse({
      subtype: 'refund', delivery_mode: 'member_reimbursement', amount_minor: 100, currency: 'USD', date: '2026-01-01',
      applications: [{ expense_id: expense, amount_minor: 100 }], allocations: [],
    }).success).toBe(false);
  });
});
