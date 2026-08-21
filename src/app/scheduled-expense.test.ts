import { describe, expect, it } from 'vitest';
import { browserTimezone, formatScheduleDate, previewScheduleDates, scheduleContinuationText, scheduleSummary, timezoneLabel, timezoneOffsetLabel, timezoneOptions } from './scheduled-expense';

describe('scheduled expense UI helpers', () => {
  it('previews weekly dates using the selected weekdays', () => {
    expect(previewScheduleDates({ startDate: '2026-01-01', endDate: null, frequency: 'weekly', interval: 1, weekdays: [1, 3] })).toEqual([
      '2026-01-05', '2026-01-07', '2026-01-12',
    ]);
  });

  it('stops previews at an inclusive end date', () => {
    expect(previewScheduleDates({ startDate: '2026-01-01', endDate: '2026-01-10', frequency: 'daily', interval: 2, weekdays: [] })).toEqual(['2026-01-01', '2026-01-03', '2026-01-05']);
    expect(previewScheduleDates({ startDate: '2026-01-01', endDate: '2026-01-02', frequency: 'daily', interval: 1, weekdays: [] }, '2026-01-03')).toEqual([]);
  });

  it('limits the preview to three dates and suppresses continuation when empty', () => {
    expect(previewScheduleDates({ startDate: '2026-01-01', endDate: null, frequency: 'daily', interval: 1, weekdays: [] })).toHaveLength(3);
    expect(scheduleContinuationText('2026-01-02', [])).toBe('');
  });

  it('describes custom intervals and exposes a browser timezone fallback', () => {
    expect(scheduleSummary('monthly', 2, [])).toBe('Monthly every 2');
    expect(browserTimezone()).toEqual(expect.any(String));
  });

  it('formats preview dates and describes schedule continuation explicitly', () => {
    expect(formatScheduleDate('2026-01-05', 'en-US')).toBe('Jan 5, 2026');
    expect(scheduleContinuationText(null, ['2026-01-05'])).toBe('It continues until you pause or cancel it.');
    expect(scheduleContinuationText('2026-02-01', ['2026-01-05'])).toMatch(/^It continues through /);
    expect(scheduleContinuationText('2026-01-05', ['2026-01-05'])).toMatch(/^It ends on /);
  });

  it('keeps IANA timezone IDs while showing fractional UTC offsets', () => {
    const date = new Date('2026-01-05T00:00:00Z');
    expect(timezoneOffsetLabel('Asia/Kolkata', date)).toBe('UTC+05:30');
    expect(timezoneLabel('Asia/Kolkata', date)).toContain('Asia/Kolkata (UTC+05:30)');
    expect(timezoneOptions()).toContain('UTC');
  });
});
