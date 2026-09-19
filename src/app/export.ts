export type PagedExport<T> = { items: T[]; nextCursor?: string };

/** Join CSV response pages while retaining one header and one row boundary. */
export function assembleCsvPages(pages: string[], header: string): string {
  return pages.map((page, index) => {
    if (index === 0 || !page.startsWith(header)) return page;
    return page.slice(header.length).replace(/^\r?\n/, '');
  }).join('\n');
}

export type GroupExportPage<TExpense, TSettlement, TGroup, TMember, TSplitDefault = unknown> = {
  group: TGroup | null;
  splitDefault?: TSplitDefault | null;
  members: TMember[];
  expenses: TExpense[];
  settlements: TSettlement[];
  credits?: unknown[];
  nextCursor?: { expenses: string | null; settlements: string | null; credits?: string | null };
};

/** Collect two independently exhausted cursor streams without restarting either stream. */
export async function collectPagedGroupExport<TExpense extends { id: string }, TSettlement extends { id: string }, TGroup, TMember, TSplitDefault = unknown>(
  load: (cursors: { expenseCursor?: string | null; settlementCursor?: string | null; creditCursor?: string | null }, signal: AbortSignal) => Promise<GroupExportPage<TExpense, TSettlement, TGroup, TMember, TSplitDefault>>,
  signal: AbortSignal,
  onPage?: (page: number) => void,
) {
  let expenseCursor: string | null | undefined;
  let settlementCursor: string | null | undefined;
  let creditCursor: string | null | undefined;
  let creditsSupported = false;
  let group: TGroup | null = null;
  let splitDefault: TSplitDefault | null = null;
  let splitDefaultSet = false;
  let members: TMember[] = [];
  const expenses: TExpense[] = [], settlements: TSettlement[] = [], credits: unknown[] = [];
  const expenseIds = new Set<string>(), settlementIds = new Set<string>(), creditIds = new Set<string>();
  let pageNumber = 0;
  do {
    if (signal.aborted) throw new DOMException('The export was cancelled', 'AbortError');
    const cursors: { expenseCursor?: string | null; settlementCursor?: string | null; creditCursor?: string | null } = { expenseCursor, settlementCursor };
    if (creditsSupported) cursors.creditCursor = creditCursor;
    const page = await load(cursors, signal);
    group ??= page.group;
    if (!splitDefaultSet && page.splitDefault !== undefined) { splitDefault = page.splitDefault ?? null; splitDefaultSet = true; }
    if (!members.length) members = page.members;
    for (const item of page.expenses) if (!expenseIds.has(item.id)) { expenseIds.add(item.id); expenses.push(item); }
    for (const item of page.settlements) if (!settlementIds.has(item.id)) { settlementIds.add(item.id); settlements.push(item); }
    if (page.credits) for (const credit of page.credits) { const id = typeof credit === 'object' && credit !== null && 'id' in credit ? String((credit as { id: unknown }).id) : JSON.stringify(credit); if (!creditIds.has(id)) { creditIds.add(id); credits.push(credit); } }
    expenseCursor = page.nextCursor?.expenses ?? null;
    settlementCursor = page.nextCursor?.settlements ?? null;
    if (page.credits !== undefined || page.nextCursor?.credits !== undefined) creditsSupported = true;
    creditCursor = page.nextCursor?.credits ?? null;
    pageNumber += 1;
    onPage?.(pageNumber);
  } while (expenseCursor !== null || settlementCursor !== null || creditCursor !== null);
  return { group, splitDefault, members, expenses, settlements, credits };
}

/** Collect a bounded cursor stream while preserving cancellation semantics. */
export async function collectPagedExport<T>(load: (cursor: string | undefined, signal: AbortSignal) => Promise<PagedExport<T>>, signal: AbortSignal, onPage?: (page: number) => void): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  let pageNumber = 0;
  do {
    if (signal.aborted) throw new DOMException('The export was cancelled', 'AbortError');
    const page = await load(cursor, signal);
    items.push(...page.items);
    pageNumber += 1;
    onPage?.(pageNumber);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

type AccountGroupPage<TExpense, TSettlement, TGroup, TMember, TSplitDefault = unknown> = {
  group: TGroup | null;
  splitDefault?: TSplitDefault | null;
  members: TMember[];
  expenses: TExpense[];
  settlements: TSettlement[];
  credits?: unknown[];
};

/** Merge account-export continuation pages into complete groups before download. */
export async function collectPagedAccountExport<TExpense extends { id: string }, TSettlement extends { id: string }, TGroup extends { id?: string }, TMember extends { personId?: string; id?: string }, TSplitDefault = unknown>(
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<{ groups: AccountGroupPage<TExpense, TSettlement, TGroup, TMember, TSplitDefault>[]; nextCursor?: string }>,
  signal: AbortSignal,
  onPage?: (page: number) => void,
) {
  const groups = new Map<string, { group: TGroup | null; splitDefault: TSplitDefault | null; members: TMember[]; expenses: TExpense[]; settlements: TSettlement[]; credits: unknown[] }>();
  const memberIds = new Map<string, Set<string>>(), expenseIds = new Map<string, Set<string>>(), settlementIds = new Map<string, Set<string>>(), creditIds = new Map<string, Set<string>>();
  let cursor: string | undefined;
  let pageNumber = 0;
  do {
    if (signal.aborted) throw new DOMException('The export was cancelled', 'AbortError');
    const page = await load(cursor, signal);
    for (const incoming of page.groups) {
      const id = incoming.group?.id;
      if (!id) continue;
       const existing = groups.get(id) || { group: incoming.group, splitDefault: incoming.splitDefault ?? null, members: [], expenses: [], settlements: [], credits: [] };
      existing.group ??= incoming.group;
      if (incoming.splitDefault !== undefined) existing.splitDefault = incoming.splitDefault ?? null;
      const members = memberIds.get(id) || new Set<string>();
      for (const member of incoming.members) {
        const memberId = member.personId || member.id || JSON.stringify(member);
        if (!members.has(memberId)) { members.add(memberId); existing.members.push(member); }
      }
      const expenses = expenseIds.get(id) || new Set<string>();
      for (const expense of incoming.expenses) if (!expenses.has(expense.id)) { expenses.add(expense.id); existing.expenses.push(expense); }
      const settlements = settlementIds.get(id) || new Set<string>();
       for (const settlement of incoming.settlements) if (!settlements.has(settlement.id)) { settlements.add(settlement.id); existing.settlements.push(settlement); }
       const credits = creditIds.get(id) || new Set<string>();
       if (incoming.credits) for (const credit of incoming.credits) { const creditId = typeof credit === 'object' && credit !== null && 'id' in credit ? String((credit as { id: unknown }).id) : JSON.stringify(credit); if (!credits.has(creditId)) { credits.add(creditId); existing.credits.push(credit); } }
       groups.set(id, existing); memberIds.set(id, members); expenseIds.set(id, expenses); settlementIds.set(id, settlements); creditIds.set(id, credits);
    }
    cursor = page.nextCursor;
    pageNumber += 1;
    onPage?.(pageNumber);
  } while (cursor);
  return [...groups.values()].map((group) => group.credits.length ? group : (({ credits: _credits, ...withoutCredits }) => withoutCredits)(group));
}
