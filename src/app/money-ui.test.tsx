import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { Money } from './ui';

afterEach(() => vi.unstubAllGlobals());

it('focuses actual overflow, remeasures values and resize, and cleans up observers/listeners', async () => {
  const node = { scrollWidth: 250, clientWidth: 242 };
  let resized!: () => void;
  const observe = vi.fn();
  const disconnect = vi.fn();
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  vi.stubGlobal('window', { addEventListener, removeEventListener });
  vi.stubGlobal('document', { fonts: { ready: Promise.resolve() } });
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(Money, { amountMinor: 999999999999, currency: 'USD' }), { createNodeMock: () => node }); });
  expect(renderer.root.findByType('strong').props.tabIndex).toBe(0);
  expect(observe).toHaveBeenCalledWith(node);
  act(() => { node.clientWidth = 300; resized(); });
  expect(renderer.root.findByType('strong').props.tabIndex).toBeUndefined();
  await act(async () => {
    node.scrollWidth = 301;
    renderer.update(createElement(Money, { amountMinor: -999999999999, currency: 'USD' }));
  });
  expect(renderer.root.findByType('strong').props.tabIndex).toBe(0);
  act(() => renderer.unmount());
  expect(disconnect).toHaveBeenCalledTimes(2);
  expect(removeEventListener.mock.calls).toEqual(addEventListener.mock.calls);
});

it('remeasures after fonts load when ResizeObserver is unavailable', async () => {
  const node = { scrollWidth: 200, clientWidth: 242 };
  let fontsReady!: () => void;
  const ready = new Promise<void>((resolve) => { fontsReady = resolve; });
  vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { fonts: { ready } });
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(createElement(Money, { amountMinor: 999999999999, currency: 'USD' }), { createNodeMock: () => node }); });
  expect(renderer.root.findByType('strong').props.tabIndex).toBeUndefined();
  await act(async () => { node.scrollWidth = 250; fontsReady(); await ready; });
  expect(renderer.root.findByType('strong').props.tabIndex).toBe(0);
  act(() => renderer.unmount());
  await act(async () => { await ready; });
});
