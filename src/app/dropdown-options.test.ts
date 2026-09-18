import { describe, expect, it } from 'vitest';
import { sortOptionsByLabel } from './dropdown-options';

describe('dropdown option ordering', () => {
  it('sorts dynamic labels without mutating the source and breaks label ties by key', () => {
    const source = [
      { id: '2', name: 'alex' },
      { id: '1', name: 'Alex' },
      { id: '3', name: 'Zoe' },
    ];

    expect(sortOptionsByLabel(source, (option) => option.name, (option) => option.id)).toEqual([
      { id: '1', name: 'Alex' },
      { id: '2', name: 'alex' },
      { id: '3', name: 'Zoe' },
    ]);
    expect(source).toEqual([
      { id: '2', name: 'alex' },
      { id: '1', name: 'Alex' },
      { id: '3', name: 'Zoe' },
    ]);
  });

  it('uses English collation for locale-sensitive labels', () => {
    expect(sortOptionsByLabel(['Zebra', 'Örebro', 'Apple'], (value) => value)).toEqual(['Apple', 'Örebro', 'Zebra']);
  });
});
