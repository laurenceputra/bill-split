import { describe, expect, it } from 'vitest';
import { appendUniquePage } from './pagination';

describe('keyset page accumulation', () => {
  it('deduplicates rows when a refreshed page overlaps the prior page', () => {
    expect(appendUniquePage([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }, { id: 'c' }], (row) => row.id)).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });
});
