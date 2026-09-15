import { describe, expect, it } from 'vitest';
import { categoryTrendDirection, categoryTrendStatus, effectiveInsightCurrency, insightBarWidth, insightCategoryColor, insightComparisonDateRange, insightCurrencySet, insightCurrencies, insightDateRange, insightMonthLabel, insightQuery, insightTrendBarHeight, insightTrendDateRange, insightTrendMaximum, insightTrendMonths, readInsightFilters, topCategoryTrends, validInsightRange } from './spending-insights';

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

  it('keeps a direct currency deep link authoritative', () => {
    expect(readInsightFilters(new URLSearchParams('period=month&currency=GBP'), now)).toMatchObject({ period: 'month', currency: 'GBP' });
  });

  it('keeps bar widths visible and ranks sparse category trends by scope', () => {
    expect(insightBarWidth(25, 100)).toBe(25);
    expect(insightBarWidth(0, 0)).toBe(0);
    const range = { trendFrom: '2024-11-01', trendTo: '2025-04-02' };
    const rows = [
      { currency: 'USD' as const, bucket: '2025-04', category: 'B', groupSpendMinor: 900, allocatedSpendMinor: 100, expenseCount: 1 },
      { currency: 'USD' as const, bucket: '2025-03', category: 'A', groupSpendMinor: 100, allocatedSpendMinor: 700, expenseCount: 1 },
    ];
    expect(topCategoryTrends(rows, 'USD', 'allocated', range).map((item) => item.category)).toEqual(['A', 'B']);
    expect(topCategoryTrends(rows, 'USD', 'group', range).map((item) => item.category)).toEqual(['B', 'A']);
    expect(topCategoryTrends(rows, 'USD', 'allocated', range)[0].values).toHaveLength(6);
    expect(topCategoryTrends(rows, 'USD', 'allocated', range)[0].values.find((item) => item.bucket === '2025-02')?.value).toBe(0);
  });

  it('uses one shared trend scale while preserving zero and small non-zero bars', () => {
    const range = { trendFrom: '2025-01-01', trendTo: '2025-06-15' };
    const rows = [
      { currency: 'USD' as const, bucket: '2025-01', category: 'Large', groupSpendMinor: 1000, allocatedSpendMinor: 1000, expenseCount: 1 },
      { currency: 'USD' as const, bucket: '2025-02', category: 'Small', groupSpendMinor: 1, allocatedSpendMinor: 1, expenseCount: 1 },
    ];
    const categories = topCategoryTrends(rows, 'USD', 'group', range);
    expect(insightTrendMaximum(categories)).toBe(1000);
    expect(insightTrendBarHeight(0, 1000)).toBe(0);
    expect(insightTrendBarHeight(1, 1000)).toBe(4);
    expect(insightTrendBarHeight(1000, 1000)).toBe(100);
  });

  it('keeps retained category colors stable when the current set changes', () => {
    const colorSet = (categories: string[]) => new Map(categories.map((category) => [category, insightCategoryColor(category)]));
    const initial = colorSet(['Travel', 'Food', 'Coffee']);
    const changed = colorSet(['Bills', 'Travel', 'Food', 'Coffee']);
    expect(changed.get('Travel')).toBe(initial.get('Travel'));
    expect(changed.get('Food')).toBe(initial.get('Food'));
    expect(changed.get('Coffee')).toBe(initial.get('Coffee'));
    expect(insightCategoryColor('Travel')).toBe(insightCategoryColor('Travel'));
  });

  it('ignores out-of-range buckets and deterministically fills only the top four categories', () => {
    const range = { trendFrom: '2025-01-01', trendTo: '2025-06-15' };
    const rows = ['D', 'C', 'B', 'A', 'E'].map((category) => ({ currency: 'USD' as const, bucket: '2025-06', category, groupSpendMinor: 1000, allocatedSpendMinor: 1000, expenseCount: 1 }));
    rows.push({ currency: 'USD', bucket: '2024-12', category: 'E', groupSpendMinor: 100000, allocatedSpendMinor: 100000, expenseCount: 1 });
    const result = topCategoryTrends(rows, 'USD', 'group', range);
    expect(result.map((item) => item.category)).toEqual(['A', 'B', 'C', 'D']);
    expect(result).toHaveLength(4);
    expect(result.find((item) => item.category === 'E')).toBeUndefined();
  });

  it('rejects unsafe category amount and count aggregation', () => {
    const range = { trendFrom: '2025-01-01', trendTo: '2025-06-15' };
    const row = { currency: 'USD' as const, bucket: '2025-06', category: 'Overflow', groupSpendMinor: Number.MAX_SAFE_INTEGER, allocatedSpendMinor: Number.MAX_SAFE_INTEGER, expenseCount: 1 };
    expect(() => topCategoryTrends([row, row], 'USD', 'group', range)).toThrow('safe integer range');
  });

  it('keeps category statuses honest about incomplete months', () => {
    const months = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];
    const item = { category: 'Food', currency: 'USD' as const, total: 300, values: months.map((bucket, index) => ({ bucket, value: index === 3 ? 100 : index === 4 ? 200 : index === 5 ? 300 : 0, expenseCount: 1 })) };
    expect(categoryTrendStatus(item, months).text).toContain('from Apr to May');
    const down = { ...item, values: months.map((bucket, index) => ({ bucket, value: index === 3 ? 200 : index === 4 ? 100 : 0, expenseCount: 1 })) };
    expect(categoryTrendStatus(down, months)).toMatchObject({ kind: 'down' });
    const unchanged = { ...item, values: months.map((bucket, index) => ({ bucket, value: index === 3 || index === 4 ? 100 : 0, expenseCount: 1 })) };
    expect(categoryTrendStatus(unchanged, months)).toMatchObject({ kind: 'unchanged' });
    const firstSeen = { ...item, values: months.map((bucket, index) => ({ bucket, value: index === 5 ? 300 : 0, expenseCount: 1 })), total: 300 };
    expect(categoryTrendStatus(firstSeen, months)).toMatchObject({ kind: 'first-seen' });
    const resumed = { ...item, values: months.map((bucket, index) => ({ bucket, value: index === 1 || index === 5 ? 300 : 0, expenseCount: 1 })), total: 600 };
    expect(categoryTrendStatus(resumed, months)).toMatchObject({ kind: 'resumed' });
    const resumedCompleted = { ...item, values: months.map((bucket, index) => ({ bucket, value: index === 1 || index === 4 ? 300 : 0, expenseCount: 1 })), total: 600 };
    expect(categoryTrendStatus(resumedCompleted, months)).toMatchObject({ kind: 'resumed' });
    const resumedAfterComparisonHistory = { ...item, values: months.slice(-3).map((bucket, index) => ({ bucket, value: index === 0 || index === 2 ? 300 : 0, expenseCount: 1 })), total: 600 };
    expect(categoryTrendStatus(resumedAfterComparisonHistory, months.slice(-3))).toMatchObject({ kind: 'resumed' });
  });

  it('uses local calendar boundaries across leap years', () => {
    expect(insightDateRange('month', new Date(2024, 1, 29, 23, 59))).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(insightDateRange('last-month', new Date(2024, 2, 1))).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(validInsightRange('2024-02-29', '2024-03-01')).toBe(true);
    expect(validInsightRange('2024-03-01', '2024-02-29')).toBe(false);
    expect(insightBarWidth(0, 100)).toBe(0);
  });

  it('covers six local calendar months across year and leap boundaries', () => {
    expect(insightTrendDateRange(new Date(2024, 2, 1))).toEqual({ trendFrom: '2023-10-01', trendTo: '2024-03-01' });
    expect(insightTrendDateRange(new Date(2024, 1, 29, 23, 59))).toEqual({ trendFrom: '2023-09-01', trendTo: '2024-02-29' });
    expect(insightTrendMonths({ trendFrom: '2023-09-01', trendTo: '2024-02-29' })).toEqual(['2023-09', '2023-10', '2023-11', '2023-12', '2024-01', '2024-02']);
    expect(categoryTrendDirection(100, 0)).toBe('new');
    expect(categoryTrendDirection(0, 0)).toBe('unchanged');
    expect(categoryTrendDirection(50, 100)).toBe('down');
    expect(categoryTrendDirection(100, 50)).toBe('up');
    expect(insightMonthLabel('2024-03')).toMatch(/Mar/i);
  });

  it('builds explicit comparison intervals for every preset and custom range', () => {
    const marchThirteenth = new Date(2026, 2, 13, 12);
    expect(insightComparisonDateRange('month', insightDateRange('month', marchThirteenth), marchThirteenth)).toEqual({ from: '2026-02-01', to: '2026-02-13' });
    const marchThirtyFirst = new Date(2026, 2, 31, 12);
    expect(insightComparisonDateRange('month', insightDateRange('month', marchThirtyFirst), marchThirtyFirst)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    const leapDay = new Date(2024, 1, 29, 12);
    expect(insightComparisonDateRange('year', insightDateRange('year', leapDay), leapDay)).toEqual({ from: '2023-01-01', to: '2023-02-28' });
    expect(insightComparisonDateRange('last-month', insightDateRange('last-month', marchThirtyFirst), marchThirtyFirst)).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(insightComparisonDateRange('custom', { from: '2024-03-01', to: '2024-03-31' })).toEqual({ from: '2024-01-30', to: '2024-02-29' });
    expect(insightComparisonDateRange('all', {})).toEqual({});
  });

  it('keeps current and previous-only currencies in the summary currency union', () => {
    expect(insightCurrencySet({ scope: 'global', summaries: [{ currency: 'USD', groupSpendMinor: 100, allocatedSpendMinor: 100, yourShareMinor: 100, youPaidMinor: 0, expenseCount: 1 }], previous: { from: '2026-01-01', to: '2026-01-31', summaries: [{ currency: 'EUR', groupSpendMinor: 100, allocatedSpendMinor: 100, yourShareMinor: 100, youPaidMinor: 0, expenseCount: 1 }] } }, { scope: 'global', trendFrom: '2026-01-01', trendTo: '2026-06-01', categoryTrends: [] })).toEqual(['EUR', 'USD']);
  });

  it('keeps a valid URL currency tab available when its current data is empty', () => {
    const summary = { scope: 'global' as const, summaries: [{ currency: 'USD' as const, groupSpendMinor: 100, allocatedSpendMinor: 100, yourShareMinor: 100, youPaidMinor: 0, expenseCount: 1 }] };
    const trends = { scope: 'global' as const, trendFrom: '2026-01-01', trendTo: '2026-06-01', categoryTrends: [] };
    const currencies = insightCurrencies(summary, trends, 'EUR');
    expect(currencies).toEqual(['EUR', 'USD']);
    expect(effectiveInsightCurrency('EUR', currencies)).toBe('EUR');
    expect(effectiveInsightCurrency(undefined, currencies, ['USD'])).toBe('USD');
    expect(effectiveInsightCurrency('GBP', currencies)).toBe('EUR');
  });

  it('keeps the first effective implicit currency when more data resolves', () => {
    const initial = insightCurrencies({ scope: 'global', summaries: [{ currency: 'EUR', groupSpendMinor: 100, allocatedSpendMinor: 100, yourShareMinor: 100, youPaidMinor: 0, expenseCount: 1 }] }, undefined);
    const resolved = insightCurrencies({ scope: 'global', summaries: [{ currency: 'USD', groupSpendMinor: 100, allocatedSpendMinor: 100, yourShareMinor: 100, youPaidMinor: 0, expenseCount: 1 }] }, { scope: 'global', trendFrom: '2026-01-01', trendTo: '2026-06-01', categoryTrends: [{ currency: 'EUR', bucket: '2026-06', category: 'Food', groupSpendMinor: 100, allocatedSpendMinor: 100, expenseCount: 1 }] });
    const implicit = effectiveInsightCurrency(undefined, initial, initial);
    expect(implicit).toBe('EUR');
    expect(effectiveInsightCurrency(undefined, resolved, [implicit])).toBe('EUR');
  });
});
