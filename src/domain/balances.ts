import type { Currency, PairwiseBalance, Payer, Split, Settlement } from '../shared/types';
import { BalanceOverflowError, checkedAddMinor } from '../shared/money';

type Transfer = { from: string; to: string; amount: number; currency: string };
export function calculateNet(payers: Payer[], splits: Split[], settlements: Settlement[] = [], currency = 'USD'): Record<string, number> {
  const result: Record<string, number> = {};
  const add = (personId: string, amount: number) => { result[personId] = checkedAddMinor(result[personId] ?? 0, amount); };
  for (const p of payers) add(p.personId, p.amountMinor);
  for (const s of splits) add(s.personId, -s.amountMinor);
  for (const s of settlements.filter((x) => !x.deletedAt && x.currency === currency)) {
    add(s.fromPersonId, s.amountMinor);
    add(s.toPersonId, -s.amountMinor);
  }
  return result;
}
/** Pairwise balances mean “from owes to”: a positive directed transfer settles that debt. */
export function simplifyDebts(net: Record<string, number>, currency: Currency, names: Record<string, string> = {}): PairwiseBalance[] {
  for (const amount of Object.values(net)) if (!Number.isSafeInteger(amount)) throw new BalanceOverflowError();
  const creditors = Object.entries(net).filter(([, n]) => n > 0).map(([id, amount]) => ({ id, amount }));
  const debtors = Object.entries(net).filter(([, n]) => n < 0).map(([id, amount]) => ({ id, amount: -amount }));
  const result: PairwiseBalance[] = []; let i = 0; let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    result.push({ fromPersonId: debtors[i].id, fromName: names[debtors[i].id] ?? debtors[i].id, toPersonId: creditors[j].id, toName: names[creditors[j].id] ?? creditors[j].id, amountMinor: amount, currency });
    debtors[i].amount -= amount; creditors[j].amount -= amount;
    if (!debtors[i].amount) i++; if (!creditors[j].amount) j++;
  }
  return result;
}
export function transfersToNet(transfers: Transfer[]): Record<string, number> {
  const net: Record<string, number> = {}; for (const t of transfers) { net[t.from] = checkedAddMinor(net[t.from] ?? 0, -t.amount); net[t.to] = checkedAddMinor(net[t.to] ?? 0, t.amount); } return net;
}
