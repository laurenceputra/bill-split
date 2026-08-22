export type PagedExport<T> = { items: T[]; nextCursor?: string };

export type GroupExportPage<TExpense, TSettlement, TGroup, TMember> = {
  group: TGroup | null;
  members: TMember[];
  expenses: TExpense[];
  settlements: TSettlement[];
  nextCursor?: { expenses: string | null; settlements: string | null };
};

/** Collect two independently exhausted cursor streams without restarting either stream. */
export async function collectPagedGroupExport<TExpense extends { id: string }, TSettlement extends { id: string }, TGroup, TMember>(
  load: (cursors: { expenseCursor?: string | null; settlementCursor?: string | null }, signal: AbortSignal) => Promise<GroupExportPage<TExpense, TSettlement, TGroup, TMember>>,
  signal: AbortSignal,
  onPage?: (page: number) => void,
) {
  let expenseCursor: string | null | undefined;
  let settlementCursor: string | null | undefined;
  let group: TGroup | null = null;
  let members: TMember[] = [];
  const expenses: TExpense[] = [], settlements: TSettlement[] = [];
  const expenseIds = new Set<string>(), settlementIds = new Set<string>();
  let pageNumber = 0;
  do {
    if (signal.aborted) throw new DOMException('The export was cancelled', 'AbortError');
    const page = await load({ expenseCursor, settlementCursor }, signal);
    group ??= page.group;
    if (!members.length) members = page.members;
    for (const item of page.expenses) if (!expenseIds.has(item.id)) { expenseIds.add(item.id); expenses.push(item); }
    for (const item of page.settlements) if (!settlementIds.has(item.id)) { settlementIds.add(item.id); settlements.push(item); }
    expenseCursor = page.nextCursor?.expenses ?? null;
    settlementCursor = page.nextCursor?.settlements ?? null;
    pageNumber += 1;
    onPage?.(pageNumber);
  } while (expenseCursor !== null || settlementCursor !== null);
  return { group, members, expenses, settlements };
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
