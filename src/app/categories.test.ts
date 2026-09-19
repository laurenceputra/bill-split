import { describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES, categoryOptions } from './categories';

describe('expense categories', () => {
  it('provides the approved defaults and distinct custom values', () => {
    expect(DEFAULT_CATEGORIES).toEqual(['Groceries', 'Dining', 'Housing', 'Utilities', 'Transportation', 'Travel', 'Shopping', 'Entertainment', 'Health', 'Household', 'Subscriptions', 'Education', 'Childcare', 'Pets', 'Gifts', 'Fees', 'Other']);
    expect(categoryOptions(['Weekend trip', 'Weekend trip', ''])).toEqual(['Childcare', 'Dining', 'Education', 'Entertainment', 'Fees', 'Gifts', 'Groceries', 'Health', 'Household', 'Housing', 'Other', 'Pets', 'Shopping', 'Subscriptions', 'Transportation', 'Travel', 'Utilities', 'Weekend trip']);
    expect(categoryOptions(['Weekend trip', 'Weekend trip']).filter((value) => value === 'Weekend trip')).toHaveLength(1);
  });
});
