import { expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { DebtCreatePage } from './App';
import * as api from './api';
import * as ui from './ui';
import * as reload from './reload-safety';
import { resourceKeys, seedResource } from './resource-cache';
import type { GroupResponse } from '../shared/types';

it('releases the form submission lock if the update gate rejects before entering the protected write', async () => {
  const userId = 'demo-user', groupId = 'demo-group', otherId = '00000000-0000-4000-8000-000000000001';
  const group: GroupResponse = { group: { id: groupId, name: 'Sample project', currency: 'USD', createdAt: '', updatedAt: '' }, currentPersonId: 'self', members: [{ personId: otherId, name: 'Demo friend', joinedAt: '', role: 'member' }], historicalParticipants: [], splitDefault: null };
  const identity = { id: userId, personId: 'self', name: 'Demo user' };
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.spyOn(ui, 'Layout').mockImplementation(({ children }) => <>{children}</>);
  vi.spyOn(ui, 'useOnlineStatus').mockReturnValue(true);
  vi.spyOn(api, 'getMe').mockResolvedValue(identity as Awaited<ReturnType<typeof api.getMe>>);
  vi.spyOn(api, 'getGroup').mockResolvedValue(group);
  seedResource(resourceKeys.identity(), '', identity);
  seedResource(resourceKeys.group(userId, groupId), userId, group);
  const protectedOperation = vi.spyOn(reload, 'runProtectedOperation')
    .mockRejectedValueOnce(new reload.UpdatePreparingError())
    .mockRejectedValueOnce(new Error('Second attempt reached the update gate'));
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { renderer = create(<MemoryRouter><DebtCreatePage groupId={groupId} /></MemoryRouter>); });
    const form = renderer!.root.findByType('form');
    await act(async () => form.findAllByType('select')[1].props.onChange({ target: { value: otherId } }));
    await act(async () => form.findByProps({ inputMode: 'decimal' }).props.onChange({ target: { value: '12.50' } }));
    const submit = async () => { await act(async () => form.props.onSubmit({ preventDefault: () => undefined })); };
    await submit();
    expect(JSON.stringify(renderer!.toJSON())).toContain('An app update is being prepared');
    expect(form.findAllByType('button').find((button) => button.props.type === 'submit')?.props.disabled).toBe(false);
    await submit();
    expect(protectedOperation).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(renderer!.toJSON())).toContain('Second attempt reached the update gate');
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
