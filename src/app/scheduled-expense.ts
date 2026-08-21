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

export function previewScheduleDates(schedule: Pick<ScheduledExpense, 'startDate' | 'endDate' | 'frequency' | 'interval' | 'weekdays'>, fromDate = schedule.startDate, count = 5): string[] {
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

export function scheduleSummary(frequency: RecurrenceFrequency, interval: number, weekdays: Weekday[]) {
  const every = interval === 1 ? '' : ` every ${interval}`;
  if (frequency === 'weekly') return `Weekly${every} on ${weekdays.map((day) => weekdayLabels[day].short).join(', ')}`;
  return `${frequency[0].toUpperCase()}${frequency.slice(1)}${every}`;
}
