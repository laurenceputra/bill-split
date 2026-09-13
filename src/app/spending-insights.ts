import type { Currency, SpendingInsightCategoryTrend, SpendingInsightSummaryResponse, SpendingInsightTrends } from '../shared/types';
import { supportedCurrencies } from '../shared/schemas';
import { checkedAddMinor, checkedMinor } from '../shared/money';

export type InsightPeriod = 'month' | 'last-month' | 'year' | 'all' | 'custom';
export type InsightFilters = { period: InsightPeriod; from?: string; to?: string; currency?: Currency };

const pad = (value: number) => String(value).padStart(2, '0');
const calendar = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const validInsightDate = (value: string | undefined) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
export const validInsightRange = (from: string | undefined, to: string | undefined) => validInsightDate(from) && validInsightDate(to) && from! <= to!;

export function insightDateRange(period: InsightPeriod, now = new Date()): Pick<InsightFilters, 'from' | 'to'> {
  const current = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'all') return {};
  if (period === 'month') return { from: calendar(new Date(current.getFullYear(), current.getMonth(), 1)), to: calendar(current) };
  if (period === 'last-month') return { from: calendar(new Date(current.getFullYear(), current.getMonth() - 1, 1)), to: calendar(new Date(current.getFullYear(), current.getMonth(), 0)) };
  if (period === 'year') return { from: calendar(new Date(current.getFullYear(), 0, 1)), to: calendar(current) };
  return {};
}

const utcDate = (value: string) => new Date(`${value}T00:00:00Z`);
const calendarFromUtc = (value: number) => new Date(value).toISOString().slice(0, 10);
const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
const inclusiveDays = (from: string, to: string) => Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / 86_400_000) + 1;

/** Return the explicit equivalent interval used by summary comparisons. */
export function insightComparisonDateRange(period: InsightPeriod, range: Pick<InsightFilters, 'from' | 'to'>, now = new Date()): Pick<InsightFilters, 'from' | 'to'> {
  if (period === 'all' || !range.from || !range.to || !validInsightRange(range.from, range.to)) return {};
  const current = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'month') {
    const year = current.getFullYear(), month = current.getMonth() - 1;
    return { from: calendar(new Date(year, month, 1)), to: calendar(new Date(year, month, Math.min(current.getDate(), daysInMonth(year, month)))) };
  }
  if (period === 'year') {
    const year = current.getFullYear() - 1;
    return { from: calendar(new Date(year, 0, 1)), to: calendar(new Date(year, current.getMonth(), Math.min(current.getDate(), daysInMonth(year, current.getMonth())))) };
  }
  if (period === 'last-month') {
    const currentFrom = new Date(current.getFullYear(), current.getMonth() - 1, 1);
    return { from: calendar(new Date(currentFrom.getFullYear(), currentFrom.getMonth() - 1, 1)), to: calendar(new Date(currentFrom.getFullYear(), currentFrom.getMonth(), 0)) };
  }
  const previousTo = utcDate(range.from).getTime() - 86_400_000;
  const length = inclusiveDays(range.from, range.to);
  return { from: calendarFromUtc(previousTo - (length - 1) * 86_400_000), to: calendarFromUtc(previousTo) };
}

/** Categories always cover the latest six local calendar months, including the current partial month. */
export function insightTrendDateRange(now = new Date()) {
  const current = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { trendFrom: calendar(new Date(current.getFullYear(), current.getMonth() - 5, 1)), trendTo: calendar(current) };
}

export function insightTrendMonths(range: { trendFrom: string; trendTo: string }) {
  const from = new Date(`${range.trendFrom.slice(0, 7)}-01T00:00:00Z`);
  const to = new Date(`${range.trendTo.slice(0, 7)}-01T00:00:00Z`);
  const months: string[] = [];
  for (const current = new Date(from); current <= to; current.setUTCMonth(current.getUTCMonth() + 1)) months.push(current.toISOString().slice(0, 7));
  return months;
}

/** Format a UTC month key so users west of UTC never see the previous month. */
export const insightMonthLabel = (bucket: string) => new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(new Date(`${bucket}-01T00:00:00Z`));

export function readInsightFilters(search: URLSearchParams, now = new Date()): InsightFilters {
  const value = search.get('period');
  const period: InsightPeriod = value === 'last-month' || value === 'year' || value === 'all' || value === 'custom' ? value : 'month';
  // Keep custom drafts raw. The UI owns validation and must not silently turn
  // an incomplete custom range into an all-time request.
  const range = period === 'custom' ? { from: search.get('from') || undefined, to: search.get('to') || undefined } : insightDateRange(period, now);
  const selectedCurrency = search.get('currency');
  return { period, ...range, ...(supportedCurrencies.includes(selectedCurrency as Currency) ? { currency: selectedCurrency as Currency } : {}) };
}

export function insightQuery(filters: InsightFilters) {
  const query = new URLSearchParams();
  query.set('period', filters.period);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  if (filters.currency) query.set('currency', filters.currency);
  return query;
}

export const insightBarWidth = (value: number, maximum: number) => maximum > 0 ? Math.min(100, Math.max(0, Math.round((value / maximum) * 100))) : 0;
export const insightCurrencySet = (summary: SpendingInsightSummaryResponse | undefined, trends: SpendingInsightTrends | undefined) => [...new Set([...(summary?.summaries || []).map((item) => item.currency), ...(summary?.previous?.summaries || []).map((item) => item.currency), ...(trends?.categoryTrends || []).map((item) => item.currency)])].sort();
export type FilledCategoryTrend = { category: string; currency: Currency; values: Array<{ bucket: string; value: number; expenseCount: number }>; total: number };

/** Fill sparse rows, count only requested months, and rank with checked arithmetic. */
export function topCategoryTrends(rows: SpendingInsightCategoryTrend[], currency: Currency, primary: 'allocated' | 'group', range: { trendFrom: string; trendTo: string }): FilledCategoryTrend[] {
  const months = insightTrendMonths(range);
  const requestedMonths = new Set(months);
  const byCategory = new Map<string, FilledCategoryTrend>();
  for (const row of rows) {
    if (row.currency !== currency || !requestedMonths.has(row.bucket)) continue;
    const current = byCategory.get(row.category) || { category: row.category, currency, values: months.map((bucket) => ({ bucket, value: 0, expenseCount: 0 })), total: 0 };
    const value = checkedMinor(primary === 'allocated' ? row.allocatedSpendMinor : row.groupSpendMinor);
    const target = current.values.find((item) => item.bucket === row.bucket);
    if (!target) continue;
    target.value = checkedAddMinor(target.value, value);
    target.expenseCount = checkedAddMinor(target.expenseCount, checkedMinor(row.expenseCount));
    current.total = checkedAddMinor(current.total, value);
    byCategory.set(row.category, current);
  }
  return [...byCategory.values()].sort((a, b) => b.total - a.total || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0)).slice(0, 4);
}

export const categoryTrendDirection = (latest: number, previous: number): 'up' | 'down' | 'unchanged' | 'new' => previous === 0 ? (latest === 0 ? 'unchanged' : 'new') : latest > previous ? 'up' : latest < previous ? 'down' : 'unchanged';

export type CategoryTrendStatus = { kind: 'up' | 'down' | 'unchanged' | 'first-seen' | 'resumed' | 'no-baseline'; text: string };

/** Compare completed months only; current-month labels are reserved for supported first-seen/resumed cases. */
export function categoryTrendStatus(item: FilledCategoryTrend, months: string[]): CategoryTrendStatus {
  const currentMonth = months.at(-1);
  const completed = months.slice(0, -1);
  const valueFor = (bucket: string | undefined) => item.values.find((value) => value.bucket === bucket)?.value || 0;
  const current = valueFor(currentMonth);
  const latestMonth = completed.at(-1);
  const previousMonth = completed.at(-2);
  const latest = valueFor(latestMonth);
  const priorCompletedHistory = completed.slice(0, -1).some((bucket) => valueFor(bucket) > 0);
  const earlierHistory = completed.slice(0, -2).some((bucket) => valueFor(bucket) > 0);
  if (current > 0 && !completed.some((bucket) => valueFor(bucket) > 0)) return { kind: 'first-seen', text: `First seen in ${insightMonthLabel(currentMonth || '')} (month to date)` };
  if (current > 0 && priorCompletedHistory && latest === 0) return { kind: 'resumed', text: `Resumed in ${insightMonthLabel(currentMonth || '')} (month to date)` };
  if (!latestMonth || !previousMonth) return { kind: 'no-baseline', text: 'Not enough completed months for a trend' };
  const direction = categoryTrendDirection(latest, valueFor(previousMonth));
  if (direction === 'up') return { kind: 'up', text: `Up from ${insightMonthLabel(previousMonth)} to ${insightMonthLabel(latestMonth)}` };
  if (direction === 'down') return { kind: 'down', text: `Down from ${insightMonthLabel(previousMonth)} to ${insightMonthLabel(latestMonth)}` };
  if (direction === 'new') return earlierHistory ? { kind: 'resumed', text: `Resumed in ${insightMonthLabel(latestMonth)} after ${insightMonthLabel(previousMonth)}` } : { kind: 'first-seen', text: `First seen in ${insightMonthLabel(latestMonth)} after ${insightMonthLabel(previousMonth)}` };
  return { kind: 'unchanged', text: `Unchanged from ${insightMonthLabel(previousMonth)} to ${insightMonthLabel(latestMonth)}` };
}
