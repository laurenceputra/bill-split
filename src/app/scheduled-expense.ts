import { compareDates, firstOccurrenceOnOrAfter, nextOccurrenceDate, recurrenceDefinition } from '../domain/recurrence';
import type { RecurrenceFrequency, ScheduledExpense, Weekday } from '../shared/types';

export const weekdayLabels: ReadonlyArray<{ value: Weekday; label: string; short: string }> = [
  { value: 0, label: 'Sunday', short: 'Sun' }, { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' }, { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' }, { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
];

export const browserTimezone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
};

const fallbackTimezones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
export const otherTimezoneValue = '__other_iana_timezone__';

/** Return selectable IANA IDs, retaining the browser and current form values. */
export function timezoneOptions(additionalTimeZones: readonly string[] = [], browserTimeZone = browserTimezone()): string[] {
  let options: string[] = fallbackTimezones;
  try {
    const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (supportedValuesOf) options = ['UTC', ...supportedValuesOf('timeZone').filter((zone) => zone !== 'UTC')];
  } catch { /* Older browsers use the curated fallback below. */ }
  return [...new Set(['UTC', browserTimeZone, ...options, ...additionalTimeZones].filter((zone) => zone.trim()))];
}

export function timezoneSelectValue(timeZone: string, options: readonly string[], custom = false): string {
  return custom || !options.includes(timeZone) ? otherTimezoneValue : timeZone;
}

export function timezoneValueFromSelection(selection: string, customTimeZone: string): string {
  return selection === otherTimezoneValue ? customTimeZone : selection;
}

export function timezoneOffsetLabel(timeZone: string, at = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at);
    const value = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
    const match = value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!match) return 'UTC+00:00';
    const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
    return `UTC${match[1]}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  } catch { return 'UTC'; }
}

export function timezoneLabel(timeZone: string, at = new Date()) {
  return `${timeZone} (${timezoneOffsetLabel(timeZone, at)})`;
}

export function previewScheduleDates(schedule: Pick<ScheduledExpense, 'startDate' | 'endDate' | 'frequency' | 'interval' | 'weekdays'>, fromDate = schedule.startDate, count = 3): string[] {
  const definition = recurrenceDefinition(schedule);
  const dates: string[] = [];
  let candidate = firstOccurrenceOnOrAfter(definition, fromDate);
  while (candidate && dates.length < count) {
    if (schedule.endDate && compareDates(candidate, schedule.endDate) > 0) break;
    dates.push(candidate);
    candidate = nextOccurrenceDate(definition, candidate);
  }
  return dates;
}

/** Format an ISO calendar date without allowing the browser timezone to shift it. */
export function formatScheduleDate(value: string, locale?: string, timeZone = 'UTC') {
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone }).format(new Date(`${value}T00:00:00Z`));
  } catch {
    return value;
  }
}

export function scheduleContinuationText(endDate: string | null | undefined, shownDates: string[], locale?: string) {
  if (!shownDates.length) return '';
  if (!endDate) return 'It continues until you pause or cancel it.';
  const formattedEndDate = formatScheduleDate(endDate, locale);
  return shownDates.includes(endDate) ? `It ends on ${formattedEndDate}.` : `It continues through ${formattedEndDate}.`;
}

export function scheduleSummary(frequency: RecurrenceFrequency, interval: number, weekdays: Weekday[]) {
  const every = interval === 1 ? '' : ` every ${interval}`;
  if (frequency === 'weekly') return `Weekly${every} on ${weekdays.map((day) => weekdayLabels[day].short).join(', ')}`;
  return `${frequency[0].toUpperCase()}${frequency.slice(1)}${every}`;
}
