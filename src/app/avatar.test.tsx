import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Avatar, AvatarStack } from './ui';

const connection = vi.hoisted(() => ({ status: 'connected' }));
vi.mock('./api', async (importOriginal) => {
  return { ...await importOriginal<typeof import('./api')>(), getConnectionState: () => connection, subscribeConnectionState: () => () => undefined };
});

describe('shared account avatar', () => {
  it('makes no image request offline even for an opted-in cached profile', () => {
    connection.status = 'offline';
    const tree = create(<Avatar name="Cached Name" avatarMode="gravatar" avatarHash={'a'.repeat(64)} />);
    expect(tree.root.findAllByType('img')).toHaveLength(0);
    expect(tree.root.findByProps({ role: 'img' }).children).toEqual(['CN']);
    tree.unmount();
    connection.status = 'connected';
  });
  it('uses the saved name for initials and propagates opted-in metadata through stacks', () => {
    const tree = create(<AvatarStack people={[{ name: 'Bill Split' }, { name: 'Other Person', avatarMode: 'gravatar', avatarHash: 'a'.repeat(64) }]} />);
    expect(tree.root.findAllByProps({ role: 'img' })[0].children).toEqual(['BS']);
    expect(tree.root.findByType('img').props.src).toContain(`/avatar/${'a'.repeat(64)}`);
    act(() => tree.root.findByType('img').props.onError());
    expect(tree.root.findAllByType('img')).toHaveLength(0);
    expect(tree.root.findAllByProps({ role: 'img' })[1].children).toEqual(['OP']);
    tree.unmount();
  });
  it('falls back with absent hashes and clears an old image when opting out', () => {
    const tree = create(<Avatar name="Saved Name" avatarMode="gravatar" />);
    expect(tree.root.findByProps({ role: 'img' }).children).toEqual(['SN']);
    act(() => tree.update(<Avatar name="Saved Name" avatarMode="gravatar" avatarHash={'b'.repeat(64)} />));
    expect(tree.root.findAllByType('img')).toHaveLength(1);
    act(() => tree.update(<Avatar name="Saved Name" avatarMode="initials" avatarHash={'b'.repeat(64)} />));
    expect(tree.root.findByProps({ role: 'img' }).children).toEqual(['SN']);
    tree.unmount();
  });
});
