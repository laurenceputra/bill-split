import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useHomeSort } from './use-home-sort';
import type { HomeSort } from './home-sorting';

afterEach(() => vi.unstubAllGlobals());

it('keeps selections usable when storage throws and never leaks across account switches', () => {
  vi.stubGlobal('localStorage', { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
  let current: [HomeSort, (mode: HomeSort) => void];
  function Probe({ userId }: { userId?: string }) { current = useHomeSort(userId); return createElement('span', null, current[0]); }
  const view = create(createElement(Probe, { userId: 'a' }));
  act(() => current[1]('outstanding'));
  expect(current![0]).toBe('outstanding');
  act(() => view.update(createElement(Probe, { userId: 'b' })));
  expect(current![0]).toBe('name');
  act(() => view.update(createElement(Probe, {})));
  expect(current![0]).toBe('name');
  act(() => view.update(createElement(Probe, { userId: 'a' })));
  expect(current![0]).toBe('outstanding');
  view.unmount();
});
