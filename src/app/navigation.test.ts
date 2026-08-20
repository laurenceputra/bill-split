import { describe, expect, it } from 'vitest';
import { activityDetailPath, expenseDetailPath, getNavigationContext } from './navigation';

describe('expenseDetailPath', () => {
  it('requires both IDs and encodes each path segment', () => {
    expect(expenseDetailPath('group/1', 'expense 1')).toBe('/groups/group%2F1/expenses/expense%201');
    expect(expenseDetailPath(undefined, 'expense-1')).toBeUndefined();
    expect(expenseDetailPath('group-1', 'undefined')).toBeUndefined();
    expect(expenseDetailPath('group-1', '')).toBeUndefined();
  });
});

describe('activityDetailPath', () => {
  it.each([
    [{ type: 'expense', entityId: 'expense-1', entityActive: true }, '/groups/group-1/expenses/expense-1'],
    [{ type: 'expense_revision', entityId: 'expense-1', entityActive: true }, '/groups/group-1/expenses/expense-1'],
  ] as const)('links active expense activity rows', (item, path) => {
    expect(activityDetailPath('group-1', item)).toBe(path);
  });

  it.each([
    { type: 'expense_deleted', entityId: 'expense-1', entityActive: false },
    { type: 'expense_revision', entityId: 'expense-1', entityActive: false },
    { type: 'settlement', entityId: 'settlement-1', entityActive: true },
    { type: 'expense', entityId: '', entityActive: true },
    { type: 'expense', entityId: 'expense-1' },
  ])('does not link ineligible, malformed, or legacy rows: %#', (item) => {
    expect(activityDetailPath('group-1', item)).toBeUndefined();
  });
});

describe('getNavigationContext', () => {
  it('classifies the home route and makes Add mean add friend', () => {
    expect(getNavigationContext('/')).toMatchObject({
      route: 'home',
      activeSection: 'groups',
      addAction: 'add-friend',
      addLabel: 'Add friend',
      addPath: '/?friend=1',
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
      addPath: '/?friend=1',
    });
    expect(getNavigationContext('/expenses/expense-1').groupId).toBeUndefined();
  });

  it('marks settings active and ignores query strings and trailing slashes', () => {
    expect(getNavigationContext('/settings/?from=nav')).toMatchObject({ route: 'settings', activeSection: 'settings', contextualPath: '/settings' });
    expect(getNavigationContext('/groups/group-123/activity/?tab=all').activeSection).toBe('activity');
  });
});
