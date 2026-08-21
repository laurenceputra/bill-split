import { describe, expect, it } from 'vitest';
import { browserTimezone, previewScheduleDates, scheduleSummary } from './scheduled-expense';

describe('scheduled expense UI helpers', () => {
  it('previews weekly dates using the selected weekdays', () => {
    expect(previewScheduleDates({ startDate: '2026-01-01', endDate: null, frequency: 'weekly', interval: 1, weekdays: [1, 3] })).toEqual([
      '2026-01-05', '2026-01-07', '2026-01-12', '2026-01-14', '2026-01-19',
    ]);
  });

  it('stops previews at an inclusive end date', () => {
    expect(previewScheduleDates({ startDate: '2026-01-01', endDate: '2026-01-10', frequency: 'daily', interval: 2, weekdays: [] })).toEqual(['2026-01-01', '2026-01-03', '2026-01-05', '2026-01-07', '2026-01-09']);
    expect(previewScheduleDates({ startDate: '2026-01-01', endDate: '2026-01-02', frequency: 'daily', interval: 1, weekdays: [] }, '2026-01-03')).toEqual([]);
  });

  it('describes custom intervals and exposes a browser timezone fallback', () => {
    expect(scheduleSummary('monthly', 2, [])).toBe('Monthly every 2');
    expect(browserTimezone()).toEqual(expect.any(String));
  });
});
