import { describe, expect, it } from 'vitest';
import { insightBarWidth, insightDateRange, insightQuery, insightSentences, insightTransactionPath, readInsightFilters, validInsightRange } from './spending-insights';

describe('spending insight filters', () => {
  const now = new Date('2026-09-13T12:00:00.000Z');

  it('derives shareable preset ranges without converting currencies', () => {
    expect(insightDateRange('month', now)).toEqual({ from: '2026-09-01', to: '2026-09-13' });
    expect(insightDateRange('last-month', now)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(insightDateRange('year', now)).toEqual({ from: '2026-01-01', to: '2026-09-13' });
    expect(insightDateRange('all', now)).toEqual({});
  });

  it('rejects malformed custom ranges and preserves valid URL state', () => {
    const invalid = readInsightFilters(new URLSearchParams('period=custom&from=2026-02-30&to=2026-01-01&currency=bogus'), now);
    expect(invalid).toMatchObject({ period: 'custom' });
    expect(invalid.from).toBe('2026-02-30');
    const valid = readInsightFilters(new URLSearchParams('period=custom&from=2026-08-01&to=2026-08-31&currency=EUR'), now);
    expect(valid).toEqual({ period: 'custom', from: '2026-08-01', to: '2026-08-31', currency: 'EUR' });
    expect(insightQuery(valid).toString()).toBe('period=custom&from=2026-08-01&to=2026-08-31&currency=EUR');
  });

  it('keeps bar widths visible and analysis deterministic', () => {
    expect(insightBarWidth(25, 100)).toBe(25);
    expect(insightBarWidth(0, 0)).toBe(0);
    const data = {
      scope: 'global' as const,
      summaries: [{ currency: 'USD' as const, groupSpendMinor: 10000, allocatedSpendMinor: 4000, yourShareMinor: 4000, youPaidMinor: 2000, expenseCount: 2 }],
      buckets: [],
      categories: [{ currency: 'USD' as const, category: 'Food', groupSpendMinor: 10000, allocatedSpendMinor: 4000, expenseCount: 2 }],
      groups: [{ groupId: 'group-1', groupName: 'Trip', currency: 'USD' as const, allocatedSpendMinor: 4000, yourShareMinor: 4000, expenseCount: 2 }],
    };
    expect(insightSentences(data)).toEqual([
      'USD has 2 counted expenses with USD 40.00 allocated.',
      'Food is the top allocated category in USD at 40.00.',
      'Your allocated share is higher than what you paid in USD.',
      'Trip has the highest allocated spending in USD among your active groups.',
    ]);
  });

  it('uses local calendar boundaries across leap years and protects incomplete drilldowns', () => {
    expect(insightDateRange('month', new Date(2024, 1, 29, 23, 59))).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(insightDateRange('last-month', new Date(2024, 2, 1))).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(validInsightRange('2024-02-29', '2024-03-01')).toBe(true);
    expect(validInsightRange('2024-03-01', '2024-02-29')).toBe(false);
    expect(insightBarWidth(0, 100)).toBe(0);
    expect(insightTransactionPath('group/1', { period: 'custom', from: '2026-01-01', to: '2026-01-31', currency: 'EUR' }, 'Food')).toBe('/activity?group=group%2F1&view=transactions&kind=expense&from=2026-01-01&to=2026-01-31&currency=EUR&category=Food');
    const allCurrencyRange = { period: 'custom' as const, from: '2026-01-01', to: '2026-01-31' };
    expect(insightTransactionPath('group/1', { ...allCurrencyRange, currency: 'EUR' }, 'Food')).toBe('/activity?group=group%2F1&view=transactions&kind=expense&from=2026-01-01&to=2026-01-31&currency=EUR&category=Food');
    expect(insightTransactionPath('group/1', { ...allCurrencyRange, currency: 'EUR' })).toBe('/activity?group=group%2F1&view=transactions&kind=expense&from=2026-01-01&to=2026-01-31&currency=EUR');
    expect(insightTransactionPath('group-1', { period: 'all' }, 'Uncategorized')).toBe('/activity?group=group-1&view=transactions&kind=expense');
  });
});
