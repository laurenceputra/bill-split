export type NavigationRoute =
  | 'home'
  | 'settings'
  | 'group-overview'
  | 'transactions'
  | 'group-manage'
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
  addAction: 'add-friend' | 'new-expense';
  addLabel: 'Add friend' | 'Add expense';
  /** The primary destination for this navigation context. */
  primaryPath: string;
  /** The route-specific destination, when one exists. */
  contextualPath?: string;
  groupsPath: string;
  activityPath: string;
  historyPath: string;
  addPath: string;
  morePath: string;
};

const HOME_PATH = '/';

/** Build a canonical expense detail URL without ever interpolating an invalid ID. */
export function expenseDetailPath(groupId: unknown, expenseId: unknown): string | undefined {
  const valid = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !['undefined', 'null'].includes(value.trim().toLowerCase());
  if (!valid(groupId) || !valid(expenseId)) return undefined;
  return `/groups/${encodeURIComponent(groupId.trim())}/expenses/${encodeURIComponent(expenseId.trim())}`;
}

export function settlementDetailPath(groupId: unknown, settlementId: unknown): string | undefined {
  const valid = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !['undefined', 'null'].includes(value.trim().toLowerCase());
  if (!valid(groupId) || !valid(settlementId)) return undefined;
  return `/groups/${encodeURIComponent(groupId.trim())}/settlements/${encodeURIComponent(settlementId.trim())}`;
}

/** Link only activity rows whose server/cache payload explicitly proves an active expense. */
export function activityDetailPath(groupId: unknown, item: { type: string; entityId: unknown; entityActive?: boolean }): string | undefined {
  if (item.entityActive !== true || (item.type !== 'expense' && item.type !== 'expense_revision')) return undefined;
  return expenseDetailPath(groupId, item.entityId);
}

/** Link eligible current and tombstone activity rows to their transaction detail. */
export function transactionActivityPath(groupId: unknown, item: { type: string; entityId: unknown; entityActive?: boolean }): string | undefined {
  if (item.type.startsWith('settlement')) return settlementDetailPath(groupId, item.entityId);
  if (!item.type.startsWith('expense') || (item.entityActive !== true && !item.type.endsWith('_deleted'))) return undefined;
  return expenseDetailPath(groupId, item.entityId);
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Classifies the current URL and supplies all navigation destinations for it. */
export function getNavigationContext(pathname: string, search = ''): NavigationContext {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/{2,}/g, '/').replace(/\/+$/, '') || HOME_PATH;
  const segments = path.split('/').filter(Boolean).map(decodeSegment);
  const queryGroupId = path === '/activity' ? new URLSearchParams(search).get('group') || undefined : undefined;
  const groupId = segments[0] === 'groups' && segments[1] ? segments[1] : queryGroupId;
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
  else if (path === '/activity') route = 'activity';
  else if (path === '/expense/new') route = 'new-expense';
  else if (group && segments.length === 2) route = 'group-overview';
  else if (group && segments[2] === 'manage' && segments.length === 3) route = 'group-manage';
  else if (group && segments[2] === 'transactions' && segments.length === 3) route = 'transactions';
  else if (group && segments[2] === 'activity' && segments.length === 3) route = 'activity';
  else if (group && segments[2] === 'settle' && segments.length === 3) route = 'settle';
  else if (group && ((segments[2] === 'expense' && segments[3] === 'new') || (segments[2] === 'scheduled-expense' && segments[3] === 'new')) && segments.length === 4) route = 'new-expense';
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
  const canonicalActivityPath = path === '/activity' ? `${path}${search}` : group ? `/activity?group=${encodeURIComponent(group.id)}&view=changes` : '/activity';
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
    addAction: 'new-expense',
    addLabel: 'Add expense',
    primaryPath: HOME_PATH,
    contextualPath,
    groupsPath: HOME_PATH,
    activityPath: '/activity',
    historyPath: canonicalActivityPath,
    addPath: group?.addPath || '/expense/new',
    morePath: '/settings',
  };
}
