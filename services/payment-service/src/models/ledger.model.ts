/**
 * Which step of the saga a journal entry belongs to.
 *
 * FUNDING issues money into the system when a wallet is opened. The other
 * three are the legs of a payment, and a payment's history is readable from
 * this column alone: AUTHORISE + SETTLE completed, AUTHORISE + COMPENSATE was
 * refunded, AUTHORISE on its own is still in flight.
 */
export type Leg = 'FUNDING' | 'AUTHORISE' | 'SETTLE' | 'COMPENSATE';

export interface LedgerEntryRow {
  leg: Leg;
  direction: 'DEBIT' | 'CREDIT';
  amount_cents: number;
  account_id: string;
  /** Joined from accounts, so the audit trail reads without a second lookup. */
  name: string;
  created_at: Date;
}

export interface LedgerEntryDto {
  leg: Leg;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: number;
  accountId: string;
  accountName: string;
  createdAt: Date;
}

export const toLedgerEntryDto = (row: LedgerEntryRow): LedgerEntryDto => ({
  leg: row.leg,
  direction: row.direction,
  amountCents: row.amount_cents,
  accountId: row.account_id,
  accountName: row.name,
  createdAt: row.created_at,
});
