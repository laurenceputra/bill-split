import { describe, expect, it } from 'vitest';
import { groupDisplayName, groupManagementKind } from './group-display';
import type { Group } from '../shared/types';

const group = (overrides: Partial<Group> = {}): Group => ({
  id: 'group-1', name: 'With Friend', currency: 'USD', createdAt: '', updatedAt: '', ...overrides,
});

describe('group display compatibility', () => {
  it('keeps counterpart display for legacy two-person snapshots without kind', () => {
    expect(groupDisplayName(group({ memberCount: 2, counterpartName: 'Alex' }))).toBe('Alex');
    expect(groupManagementKind(group({ memberCount: 2 }))).toBe('unknown');
  });

  it('uses persisted kind for display and management decisions', () => {
    expect(groupDisplayName(group({ kind: 'peer', memberCount: 2, counterpartName: 'Alex' }))).toBe('Alex');
    expect(groupManagementKind(group({ kind: 'peer', memberCount: 2 }))).toBe('peer');
    expect(groupManagementKind(group({ kind: 'named', memberCount: 2, counterpartName: 'Alex' }))).toBe('named');
    expect(groupDisplayName(group({ kind: 'named', memberCount: 2, counterpartName: 'Alex' }))).toBe('With Friend');
  });
});
