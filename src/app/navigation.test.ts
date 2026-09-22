import { describe, expect, it } from 'vitest';
import { activityDetailPath, expenseDetailPath, getNavigationContext, getTransactionNavigation } from './navigation';

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
  it('classifies the home route with fixed global destinations', () => {
    expect(getNavigationContext('/')).toMatchObject({
      route: 'home',
      activeSection: 'groups',
      addAction: 'add-transaction',
      addLabel: 'Add transaction',
      addPath: '/add',
      primaryPath: '/',
      morePath: '/settings',
    });
  });

  it('uses the transaction chooser in both global and group contexts', () => {
    expect(getNavigationContext('/add')).toMatchObject({ route: 'add-transaction', activeSection: 'add', addPath: '/add' });
    expect(getNavigationContext('/groups/group-123/add')).toMatchObject({ route: 'add-transaction', activeSection: 'add', addPath: '/groups/group-123/add', groupId: 'group-123' });
  });

  it('does not treat the new-group routes as a group context', () => {
    for (const path of ['/groups/new', '/groups/new/add']) {
      const context = getNavigationContext(path);
      expect(context.groupId).toBeUndefined();
      expect(context.groupContext).toBeUndefined();
      expect(context.addPath).toBe('/add');
    }
    expect(getNavigationContext('/groups/group-123/add')).toMatchObject({
      groupId: 'group-123',
      groupContext: { id: 'group-123', addPath: '/groups/group-123/add' },
      addPath: '/groups/group-123/add',
    });
  });

  it('builds expense-first scoped destinations and preserves a global chooser fallback', () => {
    expect(getTransactionNavigation('group/123')).toEqual({
      primaryPath: '/groups/group%2F123/expense/new',
      primaryLabel: '+ Add expense',
      primaryAriaLabel: 'Add expense',
      options: [
        { value: 'refund', label: 'Refund/reimbursement', path: '/groups/group%2F123/refund/new', disabled: false },
        { value: 'payment', label: 'Payment between members', path: '/groups/group%2F123/settle', disabled: false },
      ],
    });
    const global = getTransactionNavigation();
    expect(global.primaryPath).toBe('/add');
    expect(global.primaryAriaLabel).toBe('Add transaction');
    expect(global.options.every((option) => option.disabled && option.path === undefined)).toBe(true);
    expect(getTransactionNavigation('group-123', false).options.every((option) => option.disabled && option.label.includes('(online only)'))).toBe(true);
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
      activityPath: '/activity',
      addPath: '/groups/group-123/add',
      morePath: '/settings',
      primaryPath: '/',
      contextualPath: '/groups/group-123/activity',
      historyPath: '/activity?group=group-123&view=changes',
    });
    expect(context.group).toEqual({
      id: 'group-123',
      overviewPath: '/groups/group-123',
      activityPath: '/groups/group-123/activity',
      settlePath: '/groups/group-123/settle',
      addPath: '/groups/group-123/add',
    });
  });

  it('preserves the canonical History query context from the current activity URL', () => {
    expect(getNavigationContext('/activity', '?group=group-123&view=transactions&from=2026-01-01')).toMatchObject({
      route: 'activity',
      groupId: 'group-123',
      activeSection: 'activity',
      historyPath: '/activity?group=group-123&view=transactions&from=2026-01-01',
    });
  });

  it('classifies insights as contextual activity and preserves shareable filters', () => {
    expect(getNavigationContext('/activity', '?group=group-123&view=insights&period=all&currency=EUR')).toMatchObject({
      route: 'activity',
      groupId: 'group-123',
      activeSection: 'activity',
      historyPath: '/activity?group=group-123&view=insights&period=all&currency=EUR',
      contextualPath: '/groups/group-123/activity',
    });
  });

  it('only marks the exact scoped expense-new destination as the primary current page', () => {
    expect(getNavigationContext('/groups/group-123/expense/new')).toMatchObject({ primaryIsCurrent: true, addPath: '/groups/group-123/add' });
    for (const path of ['/groups/group-123/refund/new', '/groups/group-123/refund/credit-1/edit', '/groups/group-123/expense/expense-1', '/groups/group-123/add', '/groups/group-123/settle']) {
      expect(getNavigationContext(path).primaryIsCurrent).toBe(false);
    }
  });

  it('does not promote a query-only History group into a scoped Add destination', () => {
    const context = getNavigationContext('/activity', '?group=group-123&view=transactions');
    expect(context).toMatchObject({
      groupId: 'group-123',
      addAction: 'add-transaction',
      addLabel: 'Add transaction',
      addPath: '/add',
      historyPath: '/activity?group=group-123&view=transactions',
    });
    expect(context.groupContext).toBeUndefined();
  });

  it.each([
    ['/groups/group-123', 'group-overview', 'groups'],
    ['/groups/group-123/manage', 'group-manage', 'groups'],
    ['/groups/group-123/add', 'add-transaction', 'add'],
    ['/groups/group-123/expense/new', 'new-expense', 'add'],
    ['/groups/group-123/scheduled-expense/new', 'new-expense', 'add'],
    ['/groups/group-123/refund/new', 'refund-create', 'add'],
    ['/groups/group-123/credit/new', 'refund-create', 'add'],
    ['/groups/group-123/refund/credit-1/edit', 'refund-edit', 'add'],
    ['/groups/group-123/credit/credit-1/edit', 'refund-edit', 'add'],
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
      addPath: '/add',
    });
    expect(getNavigationContext('/expenses/expense-1').groupId).toBeUndefined();
  });

  it('marks settings active and ignores query strings and trailing slashes', () => {
    expect(getNavigationContext('/settings/?from=nav')).toMatchObject({ route: 'settings', activeSection: 'settings', contextualPath: '/settings' });
    expect(getNavigationContext('/groups/group-123/activity/?tab=all').activeSection).toBe('activity');
  });
});
