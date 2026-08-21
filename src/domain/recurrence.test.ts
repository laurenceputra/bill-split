import { describe, expect, it } from 'vitest';
import { dueOccurrenceDates, firstOccurrenceForResume, firstOccurrenceOnOrAfter, localDateForTimeZone, nextOccurrenceDate } from './recurrence';

describe('calendar recurrence', () => {
  it('generates custom daily intervals without using elapsed hours', () => {
    const definition = { startDate: '2026-01-01', frequency: 'daily' as const, interval: 2 };
    expect(dueOccurrenceDates(definition, '2026-01-07')).toEqual(['2026-01-01', '2026-01-03', '2026-01-05', '2026-01-07']);
  });

  it('uses selected weekdays and week intervals', () => {
    const definition = { startDate: '2026-01-05', frequency: 'weekly' as const, interval: 2, weekdays: [1, 3] as [1, 3] };
    expect(dueOccurrenceDates(definition, '2026-01-19')).toEqual(['2026-01-05', '2026-01-07', '2026-01-19']);
  });

  it('clamps monthly overflow while retaining the anchored day', () => {
    const definition = { startDate: '2025-01-31', frequency: 'monthly' as const, interval: 1 };
    expect(dueOccurrenceDates(definition, '2025-05-31')).toEqual(['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30', '2025-05-31']);
  });

  it('clamps leap-day yearly schedules and honors an inclusive end date', () => {
    const definition = { startDate: '2024-02-29', endDate: '2027-02-28', frequency: 'yearly' as const, interval: 1 };
    expect(dueOccurrenceDates(definition, '2027-12-31')).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28']);
  });

  it('resolves local dates across DST boundaries', () => {
    expect(localDateForTimeZone(new Date('2026-03-08T07:30:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(firstOccurrenceOnOrAfter({ startDate: '2026-03-08', frequency: 'daily', interval: 1 })).toBe('2026-03-08');
    expect(nextOccurrenceDate({ startDate: '2026-03-08', frequency: 'daily', interval: 1 }, '2026-03-08')).toBe('2026-03-09');
  });

  it('resumes on the first occurrence on or after the timezone-local current date', () => {
    const definition = { startDate: '2026-01-01', frequency: 'daily' as const, interval: 2, endDate: '2026-01-10' };
    expect(firstOccurrenceForResume(definition, 'America/Los_Angeles', new Date('2026-01-06T00:30:00Z'))).toBe('2026-01-05');
    expect(firstOccurrenceForResume(definition, 'America/Los_Angeles', new Date('2026-01-06T08:30:00Z'))).toBe('2026-01-07');
    expect(firstOccurrenceForResume({ ...definition, startDate: '2026-01-01', endDate: '2026-01-04' }, 'UTC', new Date('2026-01-06T00:00:00Z'))).toBeNull();
  });

  it('widens the UTC candidate boundary for positive timezone offsets', () => {
    expect(firstOccurrenceForResume({ startDate: '2026-01-01', frequency: 'daily', interval: 1 }, 'Pacific/Kiritimati', new Date('2026-01-01T23:30:00Z'))).toBe('2026-01-02');
  });
});
