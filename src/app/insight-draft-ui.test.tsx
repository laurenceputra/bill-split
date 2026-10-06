import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { SpendingInsightsPage } from './App';
import { getReloadSafetyState } from './reload-safety';

vi.mock('./resource-cache', async (original) => ({ ...await original<typeof import('./resource-cache')>(), useResource: () => ({ status: 'loading', loading: true }) }));
vi.mock('./ui', async (original) => ({ ...await original<typeof import('./ui')>(), useOnlineStatus: () => true, useConnectionState: () => ({ status: 'connected' }) }));

it('protects unapplied custom dates but releases an applied range when choosing a preset', async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<MemoryRouter initialEntries={['/activity?view=insights&period=custom&from=2026-01-01&to=2026-01-31']}><SpendingInsightsPage /></MemoryRouter>); });
  try {
    expect(getReloadSafetyState().reason).toBeUndefined();
    await act(async () => renderer.root.findAllByType('input')[0].props.onChange({ target: { value: '2026-01-02' } }));
    expect(getReloadSafetyState().reason).toBe('Unapplied insight dates');
    const apply = renderer.root.findAllByType('button').find((node) => node.children.join('').includes('Apply'))!;
    await act(async () => apply.props.onClick());
    expect(getReloadSafetyState().reason).toBeUndefined();
    await act(async () => renderer.root.findAllByType('select')[0].props.onChange({ target: { value: 'month' } }));
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    expect(getReloadSafetyState().reason).toBeUndefined();
    await act(async () => renderer.root.findAllByType('select')[0].props.onChange({ target: { value: 'custom' } }));
    expect(getReloadSafetyState().reason).toBeUndefined();
    await act(async () => renderer.root.findAllByType('input')[0].props.onChange({ target: { value: '2026-02-01' } }));
    expect(getReloadSafetyState().reason).toBe('Unapplied insight dates');
  } finally { await act(async () => renderer.unmount()); }
});
