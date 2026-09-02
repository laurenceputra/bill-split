import type { GroupMember, GroupSplitDefault, Split } from './types';

type MemberOrder = Pick<GroupMember, 'personId'> & Partial<Pick<GroupMember, 'name'>>;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Return the stable order used when a split arrangement is compared. */
export function activeMemberOrder(members: MemberOrder[]): string[] {
  return [...members]
    .sort((left, right) => compareText(left.name || '', right.name || '') || compareText(left.personId, right.personId))
    .map((member) => member.personId);
}

const orderIds = (personIds: string[], members: MemberOrder[]) => {
  const order = new Map(activeMemberOrder(members).map((personId, index) => [personId, index]));
  return [...personIds].sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER) || compareText(left, right));
};

/** Normalize a stored/default arrangement and reject removed or malformed members. */
export function normalizeGroupSplitDefault(value: GroupSplitDefault | null | undefined, members: MemberOrder[]): GroupSplitDefault | null {
  if (!value || !Array.isArray(value.personIds) || !value.personIds.length || new Set(value.personIds).size !== value.personIds.length) return null;
  const active = new Set(activeMemberOrder(members));
  if (value.personIds.some((personId) => typeof personId !== 'string' || !active.has(personId))) return null;
  const personIds = orderIds(value.personIds, members);
  if (value.method === 'equal') return { method: 'equal', personIds };
  if (value.method === 'percentage') {
    if (!Array.isArray(value.values) || value.values.length !== value.personIds.length || value.values.some((item) => !Number.isInteger(item) || item < 1 || item > 10_000) || value.values.reduce((sum, item) => sum + item, 0) !== 10_000) return null;
    const valuesByPerson = new Map(value.personIds.map((personId, index) => [personId, value.values![index]]));
    return { method: 'percentage', personIds, values: personIds.map((personId) => valuesByPerson.get(personId)!) };
  }
  if (value.method === 'shares') {
    if (!Array.isArray(value.values) || value.values.length !== value.personIds.length || value.values.some((item) => !Number.isFinite(item) || item <= 0) || value.values.reduce((sum, item) => sum + item, 0) > 1_000_000) return null;
    const valuesByPerson = new Map(value.personIds.map((personId, index) => [personId, value.values![index]]));
    return { method: 'shares', personIds, values: personIds.map((personId) => valuesByPerson.get(personId)!) };
  }
  return null;
}

/** Convert expense split metadata into the same canonical default shape. */
export function normalizeExpenseSplitArrangement(splits: Pick<Split, 'personId' | 'metadata'>[], members: MemberOrder[]): GroupSplitDefault | null {
  if (!splits.length || new Set(splits.map((split) => split.personId)).size !== splits.length) return null;
  const methods = splits.map((split) => split.metadata && typeof split.metadata.method === 'string' ? split.metadata.method : undefined);
  if (methods.some((method) => method === undefined) || new Set(methods).size !== 1) return null;
  const method = methods[0];
  if (method === 'equal') return normalizeGroupSplitDefault({ method: 'equal', personIds: splits.map((split) => split.personId) }, members);
  if (method === 'percentage' || method === 'shares') {
    const values = splits.map((split) => split.metadata?.value);
    if (values.some((value) => typeof value !== 'number')) return null;
    return normalizeGroupSplitDefault({ method, personIds: splits.map((split) => split.personId), values: values as number[] }, members);
  }
  return null;
}

export function sameGroupSplitArrangement(left: GroupSplitDefault | null | undefined, right: GroupSplitDefault | null | undefined, members: MemberOrder[]): boolean {
  const a = normalizeGroupSplitDefault(left, members);
  const b = normalizeGroupSplitDefault(right, members);
  if (!a || !b || a.method !== b.method || a.personIds.length !== b.personIds.length || a.personIds.some((personId, index) => personId !== b.personIds[index])) return false;
  return a.method === 'equal' || a.values!.every((value, index) => value === b.values![index]);
}

export function splitArrangementFingerprint(value: GroupSplitDefault | null | undefined, members: MemberOrder[]): string {
  const normalized = normalizeGroupSplitDefault(value, members);
  return normalized ? JSON.stringify(normalized) : '';
}
