import type { ExpenseInput } from '../shared/schemas';
import type { ScheduledExpense } from '../shared/types';

/** Convert a template occurrence into the same ordinary expense contract used by the API. */
export function generatedExpenseInput(template: ScheduledExpense, occurrenceDate: string): ExpenseInput {
  return {
    description: template.description, amount_minor: template.amountMinor, currency: template.currency, date: occurrenceDate,
    ...(template.category ? { category: template.category } : {}),
    payers: template.payers.map((payer) => ({ person_id: payer.personId, amount_minor: payer.amountMinor })),
    splits: template.splits.map((split) => ({ person_id: split.personId, amount_minor: split.amountMinor, metadata: split.metadata })),
  };
}
