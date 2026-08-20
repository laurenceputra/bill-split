import { describe, expect, it } from 'vitest';
import { getNavigationContext } from './navigation';

describe('getNavigationContext', () => {
  it('provides group actions when a group is in the path', () => {
    expect(getNavigationContext('/groups/group-123/activity')).toEqual({
      groupId: 'group-123',
      groupsPath: '/',
      activityPath: '/groups/group-123/activity',
      addPath: '/groups/group-123/expense/new',
      morePath: '/groups/group-123/settle',
    });
  });

  it('keeps add and activity safe on the home path', () => {
    expect(getNavigationContext('/')).toEqual({ groupsPath: '/', morePath: '/settings' });
  });

  it('retains group context on canonical expense detail routes', () => {
    expect(getNavigationContext('/groups/group-123/expenses/expense-1').groupId).toBe('group-123');
  });
});
