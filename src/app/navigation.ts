export type NavigationRoute =
  | 'home'
  | 'settings'
  | 'group-overview'
  | 'activity'
  | 'settle'
  | 'new-expense'
  | 'edit-expense'
  | 'expense-detail'
  | 'legacy-expense-detail'
  | 'unknown';

export type NavigationSection = 'groups' | 'activity' | 'add' | 'settle' | 'settings';

export type GroupNavigationContext = {
  id: string;
  overviewPath: string;
  activityPath: string;
  settlePath: string;
  addPath: string;
};

export type NavigationContext = {
  route: NavigationRoute;
  groupId?: string;
  groupContext?: GroupNavigationContext;
  group?: GroupNavigationContext;
  activeSection: NavigationSection;
  addAction: 'new-group' | 'new-expense';
  addLabel: 'New group' | 'Add expense';
  /** The primary destination for this navigation context. */
  primaryPath: string;
  /** The route-specific destination, when one exists. */
  contextualPath?: string;
  groupsPath: string;
  activityPath?: string;
  addPath: string;
  morePath: string;
};

const HOME_PATH = '/';

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Classifies the current URL and supplies all navigation destinations for it. */
export function getNavigationContext(pathname: string): NavigationContext {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/{2,}/g, '/').replace(/\/+$/, '') || HOME_PATH;
  const segments = path.split('/').filter(Boolean).map(decodeSegment);
  const groupId = segments[0] === 'groups' && segments[1] ? segments[1] : undefined;
  const group = groupId
    ? {
        id: groupId,
        overviewPath: `/groups/${encodeURIComponent(groupId)}`,
        activityPath: `/groups/${encodeURIComponent(groupId)}/activity`,
        settlePath: `/groups/${encodeURIComponent(groupId)}/settle`,
        addPath: `/groups/${encodeURIComponent(groupId)}/expense/new`,
      }
    : undefined;

  let route: NavigationRoute = 'unknown';
  if (path === HOME_PATH || path === '') route = 'home';
  else if (path === '/settings') route = 'settings';
  else if (group && segments.length === 2) route = 'group-overview';
  else if (group && segments[2] === 'activity' && segments.length === 3) route = 'activity';
  else if (group && segments[2] === 'settle' && segments.length === 3) route = 'settle';
  else if (group && segments[2] === 'expense' && segments[3] === 'new' && segments.length === 4) route = 'new-expense';
  else if (group && segments[2] === 'expense' && segments[3] && segments.length === 4) route = 'edit-expense';
  else if (group && segments[2] === 'expenses' && segments[3] && segments.length === 4) route = 'expense-detail';
  else if (segments[0] === 'expenses' && segments[1] && segments.length === 2) route = 'legacy-expense-detail';

  const hasGroup = Boolean(group);
  const activeSection: NavigationSection =
    route === 'settings' ? 'settings' :
    route === 'activity' ? 'activity' :
    route === 'settle' ? 'settle' :
    route === 'new-expense' || route === 'edit-expense' ? 'add' :
    'groups';
  const contextualPath = group
    ? route === 'activity' ? group.activityPath
      : route === 'settle' ? group.settlePath
        : route === 'new-expense' || route === 'edit-expense' ? group.addPath
          : route === 'expense-detail' ? path
            : group.overviewPath
    : route === 'settings' ? '/settings' : undefined;

  return {
    route,
    ...(groupId ? { groupId, group } : {}),
    activeSection,
    ...(group ? { groupContext: group } : {}),
    addAction: hasGroup ? 'new-expense' : 'new-group',
    addLabel: hasGroup ? 'Add expense' : 'New group',
    primaryPath: group?.overviewPath || HOME_PATH,
    contextualPath,
    groupsPath: HOME_PATH,
    activityPath: group?.activityPath,
    addPath: group?.addPath || '/?new=1',
    morePath: group?.settlePath || '/settings',
  };
}
