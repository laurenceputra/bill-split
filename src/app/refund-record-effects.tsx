import type { Credit } from '../shared/types';
import { minorToInput } from './form-display';
import { savedRefundEffects } from './refund-effects';
import { LedgerList, LedgerRow, SectionHeader } from './ui';

export function RefundRecordEffects({ credit, label }: { credit: Credit; label: (id: string) => string }) {
  if (credit.deletedAt) return null;
  return <section className="reading-section"><SectionHeader title="Recorded balance effects" />
    <p>These saved allocations describe this refund’s contribution, not historical before-and-after totals or today’s balances.</p>
    <p>{credit.deliveryMode === 'member_reimbursement'
      ? 'Receipt records money already received. Cost-share reductions record who benefits, independently of who received it. Any later transfer between members is a separate payment.'
      : 'The original recorded payment and cost shares were reduced; this does not record a new receipt or a payment between members.'}</p>
    <LedgerList label="Saved refund effects">{[...savedRefundEffects(credit)].map(([personId, effect]) => <LedgerRow key={personId}><span><strong>{label(personId)}</strong><small>{effect === 0 ? 'No net balance change from this refund.' : `${minorToInput(Math.abs(effect))} ${credit.currency} ${effect > 0 ? 'added to' : 'subtracted from'} the group balance position.`}</small>{credit.allocations.filter((row) => row.personId === personId).map((row) => <small key={row.allocationType}>{row.allocationType === 'beneficiary' ? 'Cost-share reduction' : credit.deliveryMode === 'member_reimbursement' ? 'Money received' : 'Original payment reduction'}: {minorToInput(row.amountMinor)} {credit.currency}</small>)}</span></LedgerRow>)}</LedgerList>
  </section>;
}
