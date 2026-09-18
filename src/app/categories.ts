import { sortOptionsByLabel } from './dropdown-options';

export const DEFAULT_CATEGORIES = [
  'Groceries', 'Dining', 'Housing', 'Utilities', 'Transportation', 'Travel',
  'Shopping', 'Entertainment', 'Health', 'Household', 'Subscriptions',
  'Education', 'Childcare', 'Pets', 'Gifts', 'Fees', 'Other',
] as const;

export function categoryRequiresCustomText(category: string) {
  return category === 'Other';
}

export function categoryOptions(custom: readonly string[] = []) {
  return sortOptionsByLabel([...new Set([...DEFAULT_CATEGORIES, ...custom.filter((value) => value.trim())])], (value) => value);
}
