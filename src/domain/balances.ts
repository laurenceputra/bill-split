import type { Currency, PairwiseBalance, Payer, Split, Settlement } from '../shared/types';

type Transfer = { from: string; to: string; amount: number; currency: string };
export function calculateNet(payers: Payer[], splits: Split[], settlements: Settlement[] = [], currency = 'USD'): Record<string, number> {
  const result: Record<string, number> = {};
  for (const p of payers) result[p.personId] = (result[p.personId] ?? 0) + p.amountMinor;
  for (const s of splits) result[s.personId] = (result[s.personId] ?? 0) - s.amountMinor;
  for (const s of settlements.filter((x) => !x.deletedAt && x.currency === currency)) {
    result[s.fromPersonId] = (result[s.fromPersonId] ?? 0) + s.amountMinor;
    result[s.toPersonId] = (result[s.toPersonId] ?? 0) - s.amountMinor;
  }
  return result;
}
/** Pairwise balances mean “from owes to”: a positive directed transfer settles that debt. */
export function simplifyDebts(net: Record<string, number>, currency: Currency, names: Record<string, string> = {}): PairwiseBalance[] {
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
  const net: Record<string, number> = {}; for (const t of transfers) { net[t.from] = (net[t.from] ?? 0) - t.amount; net[t.to] = (net[t.to] ?? 0) + t.amount; } return net;
}
