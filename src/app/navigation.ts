export type NavigationContext = {
  groupId?: string;
  groupsPath: string;
  activityPath?: string;
  addPath?: string;
  morePath: string;
};

/** Maps the current URL to destinations that already exist in the app. */
export function getNavigationContext(pathname: string): NavigationContext {
  const match = pathname.match(/^\/groups\/([^/]+)/);
  const groupId = match?.[1];

  if (groupId) {
    return {
      groupId,
      groupsPath: '/',
      activityPath: `/groups/${groupId}/activity`,
      addPath: `/groups/${groupId}/expense/new`,
      morePath: `/groups/${groupId}/settle`,
    };
  }

  return { groupsPath: '/', morePath: '/' };
}
