import type { RecurrenceFrequency, ScheduledExpense, Weekday } from '../shared/types';

export interface RecurrenceDefinition {
  startDate: string; endDate?: string | null; frequency: RecurrenceFrequency; interval: number; weekdays?: Weekday[];
}

const isoParts = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid calendar date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
};
const format = (year: number, month: number, day: number) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const utcDay = (value: string) => { const p = isoParts(value); return new Date(Date.UTC(p.year, p.month - 1, p.day)); };
const fromUtcDay = (value: Date) => format(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
export const compareDates = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const addCalendarDays = (value: string, days: number) => { const result = utcDay(value); result.setUTCDate(result.getUTCDate() + days); return fromUtcDay(result); };
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const weekdayIndex = (value: string) => utcDay(value).getUTCDay() as Weekday;
const mondayIndex = (value: string) => (weekdayIndex(value) + 6) % 7;
const weekStart = (value: string) => addCalendarDays(value, -mondayIndex(value));
const weekDistance = (start: string, value: string) => Math.floor((utcDay(value).getTime() - utcDay(start).getTime()) / 604_800_000);

function monthlyCandidate(definition: RecurrenceDefinition, occurrenceIndex: number): string {
  const start = isoParts(definition.startDate);
  const monthIndex = start.year * 12 + start.month - 1 + occurrenceIndex * definition.interval;
  const year = Math.floor(monthIndex / 12), month = monthIndex % 12 + 1;
  return format(year, month, Math.min(start.day, daysInMonth(year, month)));
}
function yearlyCandidate(definition: RecurrenceDefinition, occurrenceIndex: number): string {
  const start = isoParts(definition.startDate), year = start.year + occurrenceIndex * definition.interval;
  return format(year, start.month, Math.min(start.day, daysInMonth(year, start.month)));
}

export function firstOccurrenceOnOrAfter(definition: RecurrenceDefinition, fromDate = definition.startDate): string | null {
  const from = compareDates(fromDate, definition.startDate) < 0 ? definition.startDate : fromDate;
  if (definition.frequency === 'daily') {
    const distance = Math.max(0, Math.ceil((utcDay(from).getTime() - utcDay(definition.startDate).getTime()) / 86_400_000));
    return addCalendarDays(definition.startDate, distance + ((definition.interval - distance % definition.interval) % definition.interval));
  }
  if (definition.frequency === 'weekly') {
    const selected = [...new Set(definition.weekdays?.length ? definition.weekdays : [weekdayIndex(definition.startDate)])].sort((a, b) => a - b);
    const anchor = weekStart(definition.startDate);
    for (let offset = 0; offset < 7 * definition.interval + 7; offset += 1) {
      const candidate = addCalendarDays(from, offset);
      const candidateWeek = weekDistance(anchor, weekStart(candidate));
      if (candidateWeek >= 0 && candidateWeek % definition.interval === 0 && selected.includes(weekdayIndex(candidate))) return candidate;
    }
    return null;
  }
  const start = isoParts(definition.startDate);
  const initial = definition.frequency === 'monthly' ? Math.max(0, Math.floor((isoParts(from).year * 12 + isoParts(from).month - 1 - (start.year * 12 + start.month - 1)) / definition.interval)) : Math.max(0, Math.floor((isoParts(from).year - start.year) / definition.interval));
  for (let index = initial; index < initial + 3; index += 1) {
    const candidate = definition.frequency === 'monthly' ? monthlyCandidate(definition, index) : yearlyCandidate(definition, index);
    if (compareDates(candidate, from) >= 0) return candidate;
  }
  return null;
}

export function nextOccurrenceDate(definition: RecurrenceDefinition, afterDate: string): string | null {
  return firstOccurrenceOnOrAfter(definition, addCalendarDays(afterDate, 1));
}

/** Reopening a schedule never replays dates that elapsed while it was paused. */
export function firstOccurrenceForResume(definition: RecurrenceDefinition, timeZone: string, asOf: Date): string | null {
  const candidate = firstOccurrenceOnOrAfter(definition, localDateForTimeZone(asOf, timeZone));
  return candidate && (!definition.endDate || compareDates(candidate, definition.endDate) <= 0) ? candidate : null;
}

export function dueOccurrenceDates(definition: RecurrenceDefinition, throughDate: string, limit = 100): string[] {
  const result: string[] = [];
  let candidate = firstOccurrenceOnOrAfter(definition);
  while (candidate && compareDates(candidate, throughDate) <= 0 && result.length < limit) {
    if (!definition.endDate || compareDates(candidate, definition.endDate) <= 0) result.push(candidate);
    candidate = nextOccurrenceDate(definition, candidate);
  }
  return result;
}

export function localDateForTimeZone(value: Date | number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value instanceof Date ? value : new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = get('year'), month = get('month'), day = get('day');
  if (!year || !month || !day) throw new Error('Unable to resolve local calendar date');
  return `${year}-${month}-${day}`;
}

/** The local calendar date immediately following a UTC calendar date. */
export const nextCalendarDate = (value: string) => addCalendarDays(value, 1);

export const recurrenceDefinition = (template: Pick<ScheduledExpense, 'startDate' | 'endDate' | 'frequency' | 'interval' | 'weekdays'>): RecurrenceDefinition => template;
