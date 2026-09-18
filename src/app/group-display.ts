import type { Group } from '../shared/types';

export type GroupManagementKind = 'peer' | 'named' | 'unknown';

/** Legacy snapshots may not have kind yet; the fallback is display-only. */
export const groupDisplayName = (group: Group) =>
  (group.kind === 'peer' || (group.kind === undefined && group.memberCount === 2)) && group.counterpartName
    ? group.counterpartName
    : group.name;

/** Unknown legacy two-person snapshots must not expose named-group controls. */
export const groupManagementKind = (group: Group): GroupManagementKind => {
  if (group.kind === 'peer') return 'peer';
  if (group.kind === 'named') return 'named';
  return 'unknown';
};
