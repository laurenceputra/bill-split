import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddFriendForm, ProfileSettings, SplitDefaultSettings, TargetedInvitationControl } from './App';
import { getReloadSafetyState } from './reload-safety';

const fixture = vi.hoisted(() => ({ user: { id: 'user', name: 'Saved name', avatarMode: 'initials' as const }, save: vi.fn() }));
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), updateDisplayName: fixture.save }));
vi.mock('./resource-cache', async (original) => ({ ...await original<typeof import('./resource-cache')>(), useResource: () => ({ data: fixture.user, status: 'ready' }) }));
vi.mock('./ui', async (original) => ({ ...await original<typeof import('./ui')>(), useConnectionState: () => ({ status: 'connected' }), useAuthLifecycle: () => ({ status: 'authenticated' }) }));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer?.unmount()); renderer = undefined; fixture.save.mockReset(); });

describe('Persistent UI draft ownership', () => {
  it('refreshes an untouched profile field without overwriting another field’s dirty draft', async () => {
    fixture.user = { ...fixture.user, name: 'Saved name' };
    await act(async () => { renderer = create(<ProfileSettings />); });
    await act(async () => renderer!.root.findByType('select').props.onChange({ target: { value: 'gravatar' } }));
    fixture.user = { ...fixture.user, name: 'Remote name' };
    await act(async () => renderer!.update(<ProfileSettings />));
    expect(renderer!.root.findByType('input').props.value).toBe('Remote name');
    expect(renderer!.root.findByType('select').props.value).toBe('gravatar');
    expect(getReloadSafetyState().reason).toBe('Unsaved profile');
    await act(async () => renderer!.root.findByType('select').props.onChange({ target: { value: 'initials' } }));
    expect(getReloadSafetyState().reason).toBeUndefined();
  });

  it('retains targeted email changes when its disclosure closes without blocking untouched initialized email', async () => {
    await act(async () => { renderer = create(<TargetedInvitationControl groupId="group" userId="user" member={{ personId: 'person', name: 'Person', email: 'saved@example.com', role: 'member', joinedAt: '' }} online mutationState="available" />); });
    expect(getReloadSafetyState().reason).toBeUndefined();
    await act(async () => renderer!.root.findByType('input').props.onChange({ target: { value: 'draft@example.com' } }));
    await act(async () => renderer!.root.findByType('details').props.onToggle({ currentTarget: { open: false } }));
    expect(getReloadSafetyState().reason).toBe('Unsaved invitation email');
    await act(async () => renderer!.root.findByType('input').props.onChange({ target: { value: 'saved@example.com' } }));
    expect(getReloadSafetyState().reason).toBeUndefined();
  });

  it('retains split-default changes while hidden and releases on semantic reversion', async () => {
    await act(async () => { renderer = create(<SplitDefaultSettings groupId="group" userId="user" members={[{ personId: 'person', name: 'Person', role: 'owner', joinedAt: '' }]} value={null} online owner onChanged={() => undefined} />); });
    const toggle = () => renderer!.root.findAllByType('button')[0];
    expect(getReloadSafetyState().reason).toBeUndefined();
    await act(async () => toggle().props.onClick());
    await act(async () => renderer!.root.findAllByType('input').find((node) => node.props.type === 'checkbox')!.props.onChange());
    await act(async () => toggle().props.onClick());
    expect(getReloadSafetyState().reason).toBe('Unsaved split default');
    await act(async () => toggle().props.onClick());
    await act(async () => renderer!.root.findAllByType('input').find((node) => node.props.type === 'checkbox')!.props.onChange());
    expect(getReloadSafetyState().reason).toBeUndefined();
  });

  it('keeps a profile draft through blur and failed save, releases semantic reversion, and hydrates untouched defaults', async () => {
    fixture.user.name = '';
    await act(async () => { renderer = create(<ProfileSettings />); });
    expect(getReloadSafetyState().reason).toBeUndefined();
    fixture.user = { ...fixture.user, name: 'Saved name' };
    await act(async () => renderer!.update(<ProfileSettings />));
    const input = () => renderer!.root.findByType('input');
    expect(input().props.value).toBe('Saved name');
    expect(getReloadSafetyState().reason).toBeUndefined();
    await act(async () => input().props.onChange({ target: { value: 'Draft name' } }));
    input().props.onBlur?.();
    expect(getReloadSafetyState().reason).toBe('Unsaved profile');
    fixture.save.mockRejectedValue(new Error('Save failed'));
    await act(async () => renderer!.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }));
    expect(getReloadSafetyState().reason).toBe('Unsaved profile');
    fixture.user = { ...fixture.user, name: 'Remote name' };
    await act(async () => renderer!.update(<ProfileSettings />));
    expect(input().props.value).toBe('Draft name');
    await act(async () => input().props.onChange({ target: { value: 'Saved name' } }));
    expect(getReloadSafetyState().reason).toBeUndefined();
  });

  it('keeps an add-friend draft owned while its editor is hidden and restores it on reopening', async () => {
    await act(async () => { renderer = create(<AddFriendForm groupId="group" userId="user" online />); });
    const toggle = () => renderer!.root.findAllByType('button')[0];
    expect(getReloadSafetyState().reason).toBeUndefined();
    await act(async () => toggle().props.onClick());
    await act(async () => renderer!.root.findAllByType('input')[0].props.onChange({ target: { value: 'Draft friend' } }));
    expect(getReloadSafetyState().reason).toBe('Unsaved friend');
    await act(async () => toggle().props.onClick());
    expect(renderer!.root.findAllByType('input')).toHaveLength(0);
    expect(getReloadSafetyState().reason).toBe('Unsaved friend');
    await act(async () => toggle().props.onClick());
    expect(renderer!.root.findAllByType('input')[0].props.value).toBe('Draft friend');
    await act(async () => renderer!.root.findAllByType('input')[0].props.onChange({ target: { value: '' } }));
    expect(getReloadSafetyState().reason).toBeUndefined();
  });
});
