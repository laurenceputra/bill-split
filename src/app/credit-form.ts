export type CreditApplicationDraft = { id: string; expenseId: string; amount: string };
export type CreditAllocationDraft = { id: string; personId: string; allocationType: 'recipient' | 'beneficiary'; amount: string };

export type CreditFormMode = 'member_reimbursement' | 'direct_provider_offset';

export type CreditFormResourceErrors = { identity?: unknown; group?: unknown; expenses?: unknown };
export type CreditFormRetryKeys = { identity: string; group: string; expenses: string };

/** Prefer identity recovery, then the failed expense load, then group data. */
export function selectCreditFormRetryKey(errors: CreditFormResourceErrors, keys: CreditFormRetryKeys): string | undefined {
  if (errors.identity !== undefined) return keys.identity;
  if (errors.expenses !== undefined) return keys.expenses;
  if (errors.group !== undefined) return keys.group;
  return undefined;
}

export function validateCreditDraft(applications: CreditApplicationDraft[], allocations: CreditAllocationDraft[], mode: CreditFormMode) {
  if (applications.some((row) => !row.expenseId || !row.amount.trim())) return 'Complete or remove every visible expense application row.';
  if (new Set(applications.map((row) => row.expenseId)).size !== applications.length) return 'Each expense can appear only once in a credit.';
  if (mode === 'member_reimbursement' && allocations.some((row) => !row.personId || !row.amount.trim())) return 'Complete or remove every visible allocation row.';
  const allocationKeys = allocations.filter((row) => row.personId).map((row) => `${row.allocationType}:${row.personId}`);
  if (new Set(allocationKeys).size !== allocationKeys.length) return 'Each person can appear only once per allocation side.';
  return undefined;
}
