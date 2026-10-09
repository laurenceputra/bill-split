import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Group } from '../shared/types';
import { homeSortKey, outstandingBalance, parseHomeSort, readHomeSort, sortHomeGroups, writeHomeSort } from './home-sorting';

const group = (id: string, overrides: Partial<Group> = {}): Group => ({ id, name: id, currency: 'USD', createdAt: '', updatedAt: '', ...overrides });
afterEach(() => vi.unstubAllGlobals());

describe('Home sorting', () => {
  it('uses display names, numeric case-insensitive ordering and deterministic IDs without mutation', () => {
    const source = Object.freeze([group('z', { name: 'room 10' }), group('b', { name: 'ROOM 2' }), group('a', { name: 'Room 2' }), group('peer', { kind: 'peer', counterpartName: 'Alex' })]);
    expect(sortHomeGroups(source, 'name').map((value) => value.id)).toEqual(['peer', 'a', 'b', 'z']);
    expect(source.map((value) => value.id)).toEqual(['z', 'b', 'a', 'peer']);
  });

  it('prefers non-zero default, then alphabetic non-zero fallback across all summaries', () => {
    const balances = Object.freeze([{ currency: 'USD', netMinor: 0 }, { currency: 'SGD', netMinor: 900 }, { currency: 'HKD', netMinor: 400 }, { currency: 'EUR', netMinor: -200 }]);
    const candidate = group('a', { balanceSummaries: balances as unknown as Group['balanceSummaries'] });
    expect(outstandingBalance(candidate)).toEqual({ currency: 'EUR', netMinor: -200 });
    expect(outstandingBalance({ ...candidate, currency: 'SGD' })).toEqual({ currency: 'SGD', netMinor: 900 });
    expect(outstandingBalance(group('empty', { balanceSummaries: [] }))).toBeUndefined();
    expect(outstandingBalance(group('unknown'))).toBeUndefined();
    expect(outstandingBalance(group('zero', { balanceSummaries: [{ currency: 'USD', netMinor: 0 }] }))).toBeUndefined();
    expect(balances.map((value) => value.currency)).toEqual(['USD', 'SGD', 'HKD', 'EUR']);
  });

  it('ranks absolute minor amounts directly across currencies, unknown before settled, with name/id ties', () => {
    const source = [group('settled', { balanceSummaries: [] }), group('unknown'), group('b', { name: 'Same', balanceSummaries: [{ currency: 'USD', netMinor: 200 }] }), group('a', { name: 'same', currency: 'INR', balanceSummaries: [{ currency: 'INR', netMinor: -200 }] }), group('large', { currency: 'EUR', balanceSummaries: [{ currency: 'EUR', netMinor: -300 }] }), group('zero', { balanceSummaries: [{ currency: 'USD', netMinor: 0 }] })];
    const before = JSON.stringify(source);
    expect(sortHomeGroups(source, 'outstanding').map((value) => value.id)).toEqual(['large', 'a', 'b', 'unknown', 'settled', 'zero']);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('defaults invalid or unavailable storage and scopes persistence to the internal account ID', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
    expect(readHomeSort('a')).toBe('name');
    values.set(homeSortKey('a'), 'invalid');
    expect(readHomeSort('a')).toBe('name');
    writeHomeSort('a', 'outstanding');
    expect(readHomeSort('a')).toBe('outstanding');
    expect(readHomeSort('b')).toBe('name');
    expect(parseHomeSort(null)).toBe('name');
    vi.stubGlobal('localStorage', { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } });
    expect(readHomeSort('a')).toBe('name');
    expect(() => writeHomeSort('a', 'outstanding')).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(readHomeSort('a')).toBe('name');
  });
});
