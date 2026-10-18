import type { Credit, Currency } from '../shared/types';
import { minorToInput } from './form-display';

/** Saved allocations are the accounting snapshot, even if linked expenses change. */
export function savedRefundEffects(credit: Credit) {
  const effects = new Map<string, number>();
  if (!credit.deletedAt) for (const row of credit.allocations) {
    effects.set(row.personId, (effects.get(row.personId) || 0) + (row.allocationType === 'recipient' ? -row.amountMinor : row.amountMinor));
  }
  return effects;
}

export function refundBalanceText(name: string, netMinor: number, currency: Currency, isCurrentPerson = false) {
  if (netMinor === 0) return `${name} ${isCurrentPerson ? 'are' : 'is'} settled up (${currency})`;
  const verb = netMinor > 0 ? (isCurrentPerson ? 'are owed' : 'is owed') : (isCurrentPerson ? 'owe' : 'owes');
  return `${name} ${verb} ${minorToInput(Math.abs(netMinor))} ${currency}`;
}

export function projectedRefundBalance(current: number, draftEffect: number, savedEffect = 0) {
  return current - savedEffect + draftEffect;
}

export function refundTransferHelp(recipients: string[], payers: string[], label: (id: string) => string, currentPersonId?: string | null) {
  const uniqueRecipients = [...new Set(recipients)];
  const uniquePayers = [...new Set(payers)];
  if (!uniqueRecipients.length || !uniquePayers.length || (uniqueRecipients.length === 1 && uniquePayers.length === 1 && uniqueRecipients[0] === uniquePayers[0])) return undefined;
  if (uniqueRecipients.length === 1 && uniquePayers.length === 1) {
    const recipient = label(uniqueRecipients[0]);
    const payer = label(uniquePayers[0]);
    return `If ${uniqueRecipients[0] === currentPersonId ? 'you' : recipient} passed or later ${uniqueRecipients[0] === currentPersonId ? 'pass' : 'passes'} this money to ${uniquePayers[0] === currentPersonId ? 'you' : payer}, record that transfer as a separate payment. This refund records receipt, not that transfer.`;
  }
  return 'If recipients pass money to original payers, record those transfers as separate payments. This refund records receipt, not those transfers.';
}
