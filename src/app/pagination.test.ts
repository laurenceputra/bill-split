import { describe, expect, it } from 'vitest';
import { appendUniquePage, createPageRequestScope } from './pagination';

describe('keyset page accumulation', () => {
  it('deduplicates rows when a refreshed page overlaps the prior page', () => {
    expect(appendUniquePage([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }, { id: 'c' }], (row) => row.id)).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });
});

describe('continuation request scopes', () => {
  it('invalidates and aborts a continuation when its group or filter changes', () => {
    const scope = createPageRequestScope();
    const oldRequest = scope.begin('group-a:all', 'cursor-a');

    scope.reset('group-b:all');
    expect(oldRequest.signal.aborted).toBe(true);
    expect(scope.isCurrent(oldRequest)).toBe(false);

    const newRequest = scope.begin('group-b:all', 'cursor-b');
    expect(scope.isCurrent(newRequest)).toBe(true);
    expect(newRequest.cursor).toBe('cursor-b');
  });

  it('keeps only the newest request for one scope current', () => {
    const scope = createPageRequestScope();
    const first = scope.begin('group-a:filtered', 'cursor-1');
    const second = scope.begin('group-a:filtered', 'cursor-1');

    expect(first.signal.aborted).toBe(true);
    expect(scope.isCurrent(first)).toBe(false);
    expect(scope.isCurrent(second)).toBe(true);
  });

  it('invalidates a continuation when its owner is disposed', () => {
    const scope = createPageRequestScope();
    const request = scope.begin('user-a:group-a', 'cursor-a');

    scope.dispose();

    expect(request.signal.aborted).toBe(true);
    expect(scope.isCurrent(request)).toBe(false);
  });
});
