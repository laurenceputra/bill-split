import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Settle, SettlementDetail } from './App';
import { Button } from './ui';

const fixture = vi.hoisted(() => ({ online: true, stale: false, offline: false, revalidating: false, amount: 900 }));
vi.mock('react-router-dom', async (original) => ({ ...await original<typeof import('react-router-dom')>(), useParams: () => ({ id: 'group', settlementId: 'payment' }) }));
vi.mock('./ui', async (original) => ({ ...await original<typeof import('./ui')>(), Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, useOnlineStatus: () => fixture.online }));
vi.mock('./resource-cache', async (original) => ({ ...await original<typeof import('./resource-cache')>(), useResource: (key: string) => {
  const data = key === 'identity' ? { id: 'user' }
    : key.startsWith('group:') ? { group: { id: 'group', name: 'Sample project', currency: 'USD' }, currentPersonId: 'a', members: ['a', 'b', 'c'].map((personId) => ({ personId, name: `Demo ${personId}`, role: 'member', joinedAt: '' })) }
    : key.startsWith('settlement-detail:') ? { settlement: { id: 'payment', groupId: 'group', fromPersonId: 'a', toPersonId: 'b', amountMinor: 500, currency: 'USD', date: '2026-01-01', version: 1 } }
    : key.startsWith('balances:') ? { balances: { USD: { raw: [], simplified: [{ fromPersonId: 'a', toPersonId: 'b', amountMinor: fixture.amount, currency: 'USD' }, { fromPersonId: 'a', toPersonId: 'c', amountMinor: fixture.amount * 2, currency: 'USD' }] } } } : undefined;
  return { data, status: 'ready', stale: key.startsWith('balances:') && fixture.stale, offline: key.startsWith('balances:') && fixture.offline, revalidating: key.startsWith('balances:') && fixture.revalidating };
} }));

let renderer: ReactTestRenderer;
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });
beforeEach(() => { Object.assign(fixture, { online: true, stale: false, offline: false, revalidating: false, amount: 900 }); });
const render = async (edit = false) => { await act(async () => { renderer = create(<MemoryRouter>{edit ? <SettlementDetail /> : <Settle />}</MemoryRouter>); }); };
const update = async (edit = false) => { await act(async () => renderer.update(<MemoryRouter>{edit ? <SettlementDetail /> : <Settle />}</MemoryRouter>)); };
const amount = () => renderer.root.findAllByType('input').find((node) => node.props.inputMode === 'decimal')!;
const change = async (node: ReactTestInstance, value: string) => { await act(async () => node.props.onChange({ target: { value } })); };

describe('settlement draft suggestion ownership', () => {
  it('recalculates pair/currency automatic amounts despite general draft dirtiness', async () => {
    await render();
    expect(amount().props.value).toBe('9.00');
    await change(renderer.root.findAllByType('select')[1], 'c');
    expect(amount().props.value).toBe('18.00');
    await change(renderer.root.findAllByType('select')[2], 'EUR');
    expect(amount().props.value).toBe('');
    await change(renderer.root.findAllByType('select')[2], 'USD');
    expect(amount().props.value).toBe('18.00');
    await change(amount(), '4.25');
    fixture.amount = 1200; await update();
    expect(amount().props.value).toBe('4.25');
  });

  for (const unavailable of ['stale', 'offline', 'revalidating'] as const) {
    it(`preserves an edit draft and rejects ${unavailable} old breakdown suggestions`, async () => {
      await render(true);
      await act(async () => renderer.root.findAllByType(Button).find((node) => node.props.children === 'Edit settlement')!.props.onClick());
      expect(amount().props.value).toBe('5.00');
      fixture[unavailable] = true; await update(true);
      await change(renderer.root.findAllByType('select')[1], 'c');
      expect(amount().props.value).toBe('5.00');
      fixture[unavailable] = false; fixture.amount = 1200; await update(true);
      expect(amount().props.value).toBe('24.00');
      await change(amount(), '3.25');
      fixture.amount = 2000; await update(true);
      expect(amount().props.value).toBe('3.25');
    });
  }
});
