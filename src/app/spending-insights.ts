import type { Currency, SpendingInsightCategory, SpendingInsightSummary, SpendingInsights } from '../shared/types';
import { supportedCurrencies } from '../shared/schemas';

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

export function insightTransactionPath(groupId: string | undefined, filters: InsightFilters, category?: string) {
  const query = new URLSearchParams();
  if (groupId) query.set('group', groupId);
  query.set('view', 'transactions');
  query.set('kind', 'expense');
  if (filters.from && filters.to && validInsightRange(filters.from, filters.to)) { query.set('from', filters.from); query.set('to', filters.to); }
  if (filters.currency) query.set('currency', filters.currency);
  if (category && category !== 'Uncategorized') query.set('category', category);
  return `/activity?${query}`;
}

export const insightBarWidth = (value: number, maximum: number) => maximum > 0 ? Math.round((value / maximum) * 100) : 0;
export const insightCurrencySet = (data: SpendingInsights | undefined) => [...new Set((data?.summaries || []).map((item) => item.currency))].sort();
export const insightCurrencyChoices = (data: SpendingInsights | undefined, selected?: Currency) => [...new Set([...insightCurrencySet(data), ...(selected ? [selected] : [])])].sort();
export const summaryForCurrency = (summaries: SpendingInsightSummary[], currency: Currency) => summaries.find((item) => item.currency === currency);
export const categoriesForCurrency = (categories: SpendingInsightCategory[], currency: Currency) => categories.filter((item) => item.currency === currency).sort((a, b) => b.allocatedSpendMinor - a.allocatedSpendMinor || a.category.localeCompare(b.category));

export function insightSentences(data: SpendingInsights, currency?: Currency): string[] {
  const sentences: string[] = [];
  const currencies = [...new Set(data.summaries.filter((item) => !currency || item.currency === currency).map((item) => item.currency))].sort();
  for (const currentCurrency of currencies) {
    const summary = data.summaries.find((item) => item.currency === currentCurrency);
    if (!summary) continue;
    sentences.push(`${currentCurrency} has ${summary.expenseCount} counted expense${summary.expenseCount === 1 ? '' : 's'} with ${currentCurrency} ${(summary.allocatedSpendMinor / 100).toFixed(2)} allocated.`);
    const category = data.categories.filter((item) => item.currency === currentCurrency).sort((a, b) => b.allocatedSpendMinor - a.allocatedSpendMinor || a.category.localeCompare(b.category))[0];
    if (category) sentences.push(`${category.category} is the top allocated category in ${currentCurrency} at ${(category.allocatedSpendMinor / 100).toFixed(2)}.`);
    if (summary.yourShareMinor > summary.youPaidMinor) sentences.push(`Your allocated share is higher than what you paid in ${currentCurrency}.`);
    else sentences.push(`You paid at least as much as your allocated share in ${currentCurrency}.`);
    if (data.scope === 'global') {
      const group = data.groups?.filter((item) => item.currency === currentCurrency).sort((a, b) => b.allocatedSpendMinor - a.allocatedSpendMinor || a.groupName.localeCompare(b.groupName))[0];
      if (group) sentences.push(`${group.groupName} has the highest allocated spending in ${currentCurrency} among your active groups.`);
    } else {
      const participant = data.participants?.filter((item) => item.currency === currentCurrency).sort((a, b) => b.shareMinor - a.shareMinor || a.name.localeCompare(b.name))[0];
      if (participant) sentences.push(`${participant.name} carries the largest allocated share in ${currentCurrency}.`);
    }
  }
  if (!sentences.length) sentences.push('There are no counted expenses in this period.');
  return sentences.slice(0, 4);
}
