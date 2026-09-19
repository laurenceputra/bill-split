export type CreditApplicationDraft = { id: string; expenseId: string; amount: string };
export type CreditAllocationDraft = { id: string; personId: string; allocationType: 'recipient' | 'beneficiary'; amount: string };

export type CreditFormMode = 'member_reimbursement' | 'direct_provider_offset';

export function validateCreditDraft(applications: CreditApplicationDraft[], allocations: CreditAllocationDraft[], mode: CreditFormMode) {
  if (applications.some((row) => !row.expenseId || !row.amount.trim())) return 'Complete or remove every visible expense application row.';
  if (new Set(applications.map((row) => row.expenseId)).size !== applications.length) return 'Each expense can appear only once in a credit.';
  if (mode === 'member_reimbursement' && allocations.some((row) => !row.personId || !row.amount.trim())) return 'Complete or remove every visible allocation row.';
  const allocationKeys = allocations.filter((row) => row.personId).map((row) => `${row.allocationType}:${row.personId}`);
  if (new Set(allocationKeys).size !== allocationKeys.length) return 'Each person can appear only once per allocation side.';
  return undefined;
}
