import type { Balances, Credit, Currency } from '../shared/types';

/** Saved allocations are the accounting snapshot, even if linked expenses change. */
export function savedRefundEffects(credit: Credit) {
  const effects = new Map<string, number>();
  if (!credit.deletedAt) for (const row of credit.allocations) {
    effects.set(row.personId, (effects.get(row.personId) || 0) + (row.allocationType === 'recipient' ? -row.amountMinor : row.amountMinor));
  }
  return effects;
}

export function projectedRefundBalance(current: number, draftEffect: number, savedEffect = 0) {
  return current - savedEffect + draftEffect;
}

function previewMoney(amount: number, currency: Currency) {
  const minor = Math.abs(amount);
  const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.floor(minor / 100));
  return `${currency} ${whole}.${String(minor % 100).padStart(2, '0')}`;
}

export function refundBalanceSummary(netMinor: number, currency: Currency) {
  return netMinor === 0 ? `settled up (${currency})` : `${netMinor < 0 ? 'owes' : 'owed'} ${previewMoney(netMinor, currency)}`;
}

/** Never turn a two-person subset of a larger ledger into a pairwise debt. */
export function refundPairOutcome(participantIds: string[], raw: Balances['raw'] | undefined, currentPersonId: string | null | undefined, label: (id: string) => string, currency: Currency, effect: (id: string) => number) {
  const ids = [...new Set([...participantIds, ...(raw || []).map((row) => row.personId)])];
  if (ids.length !== 2 || !currentPersonId || !ids.includes(currentPersonId) || raw?.length !== 2) return undefined;
  const otherId = ids.find((id) => id !== currentPersonId)!;
  const current = raw.find((row) => row.personId === currentPersonId);
  const other = raw.find((row) => row.personId === otherId);
  if (!current || !other || raw.some((row) => row.currency !== currency || !Number.isSafeInteger(row.netMinor)) || current.netMinor !== -other.netMinor) return undefined;
  const after = current.netMinor + effect(currentPersonId);
  const otherAfter = other.netMinor + effect(otherId);
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(otherAfter) || after !== -otherAfter) return undefined;
  const name = label(otherId);
  const money = (amount: number) => previewMoney(amount, currency);
  const outcome = after === 0 ? `You and ${name} will be settled up` : after < 0 ? `You’ll owe ${name} ${money(after)}` : `${name} will owe you ${money(after)}`;
  const currently = current.netMinor === 0 ? `you and ${name} are settled up` : current.netMinor < 0 ? `you owe ${name} ${money(current.netMinor)}` : `${name} owes you ${money(current.netMinor)}`;
  const detail = after === current.netMinor ? 'Balance unchanged.' : after !== 0 && Math.sign(after) === Math.sign(current.netMinor)
    ? `${Math.abs(after) < Math.abs(current.netMinor) ? 'Down' : 'Up'} from ${money(current.netMinor)}.` : `Currently, ${currently}.`;
  return { outcome, detail };
}

export function refundTransferHelp(recipients: string[], payers: string[], label: (id: string) => string, currentPersonId?: string | null) {
  const uniqueRecipients = [...new Set(recipients)];
  const uniquePayers = [...new Set(payers)];
  if (!uniqueRecipients.length || !uniquePayers.length || (uniqueRecipients.length === 1 && uniquePayers.length === 1 && uniqueRecipients[0] === uniquePayers[0])) return undefined;
  if (uniqueRecipients.length === 1 && uniquePayers.length === 1) {
    const recipient = label(uniqueRecipients[0]);
    const payer = label(uniquePayers[0]);
    return `If ${uniqueRecipients[0] === currentPersonId ? 'you' : recipient} passed or later ${uniqueRecipients[0] === currentPersonId ? 'pass' : 'passes'} this money to ${uniquePayers[0] === currentPersonId ? 'you' : payer}, record that transfer as a separate payment.`;
  }
  return 'If recipients pass money to original payers, record those transfers as separate payments.';
}
