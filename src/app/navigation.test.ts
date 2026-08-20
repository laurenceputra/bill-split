import { describe, expect, it } from 'vitest';
import { getNavigationContext } from './navigation';

describe('getNavigationContext', () => {
  it('classifies the home route and makes Add mean new group', () => {
    expect(getNavigationContext('/')).toMatchObject({
      route: 'home',
      activeSection: 'groups',
      addAction: 'new-group',
      addLabel: 'New group',
      addPath: '/?new=1',
      primaryPath: '/',
      morePath: '/settings',
    });
  });

  it('classifies every group destination with explicit context', () => {
    const context = getNavigationContext('/groups/group-123/activity');
    expect(context).toMatchObject({
      route: 'activity',
      groupId: 'group-123',
      activeSection: 'activity',
      addAction: 'new-expense',
      addLabel: 'Add expense',
      groupsPath: '/',
      activityPath: '/groups/group-123/activity',
      addPath: '/groups/group-123/expense/new',
      morePath: '/groups/group-123/settle',
      primaryPath: '/groups/group-123',
      contextualPath: '/groups/group-123/activity',
    });
    expect(context.group).toEqual({
      id: 'group-123',
      overviewPath: '/groups/group-123',
      activityPath: '/groups/group-123/activity',
      settlePath: '/groups/group-123/settle',
      addPath: '/groups/group-123/expense/new',
    });
  });

  it.each([
    ['/groups/group-123', 'group-overview', 'groups'],
    ['/groups/group-123/expense/new', 'new-expense', 'add'],
    ['/groups/group-123/expense/expense-1', 'edit-expense', 'add'],
    ['/groups/group-123/expenses/expense-1', 'expense-detail', 'groups'],
    ['/groups/group-123/settle', 'settle', 'settle'],
  ] as const)('classifies %s as %s', (path, route, activeSection) => {
    expect(getNavigationContext(path)).toMatchObject({ route, activeSection, groupId: 'group-123' });
  });

  it('retains the legacy detail classification without inventing group context', () => {
    expect(getNavigationContext('/expenses/expense-1')).toMatchObject({
      route: 'legacy-expense-detail',
      activeSection: 'groups',
      primaryPath: '/',
      addPath: '/?new=1',
    });
    expect(getNavigationContext('/expenses/expense-1').groupId).toBeUndefined();
  });

  it('marks settings active and ignores query strings and trailing slashes', () => {
    expect(getNavigationContext('/settings/?from=nav')).toMatchObject({ route: 'settings', activeSection: 'settings', contextualPath: '/settings' });
    expect(getNavigationContext('/groups/group-123/activity/?tab=all').activeSection).toBe('activity');
  });
});
