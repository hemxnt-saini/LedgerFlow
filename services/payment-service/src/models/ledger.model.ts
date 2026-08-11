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

/** One line of the general journal, still attached to its group. */
export interface JournalLineRow {
  id: string;
  entry_group: string;
  payment_id: string | null;
  leg: Leg;
  direction: 'DEBIT' | 'CREDIT';
  amount_cents: number;
  created_at: Date;
  account_id: string;
  name: string;
}

export interface JournalLineDto {
  accountId: string;
  accountName: string;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: number;
}

/**
 * A journal entry as a unit: the debit, the credit, and what they were for.
 * Reported rather than assumed to be a pair - a group with any other shape is
 * exactly the corruption the trial balance exists to expose, so it has to be
 * displayable.
 */
export interface JournalEntryDto {
  entryGroup: string;
  paymentId: string | null;
  leg: Leg;
  createdAt: Date;
  amountCents: number;
  lines: JournalLineDto[];
  balanced: boolean;
}

/** Groups flat lines back into journal entries, newest entry first. */
export function toJournalEntries(rows: JournalLineRow[]): JournalEntryDto[] {
  const byGroup = new Map<string, JournalEntryDto>();

  for (const row of rows) {
    let entry = byGroup.get(row.entry_group);
    if (!entry) {
      entry = {
        entryGroup: row.entry_group,
        paymentId: row.payment_id,
        leg: row.leg,
        createdAt: row.created_at,
        amountCents: 0,
        lines: [],
        balanced: false,
      };
      byGroup.set(row.entry_group, entry);
    }
    entry.lines.push({
      accountId: row.account_id,
      accountName: row.name,
      direction: row.direction,
      amountCents: row.amount_cents,
    });
  }

  for (const entry of byGroup.values()) {
    // A debit line first reads the way a journal is written.
    entry.lines.sort((a, b) => (a.direction === 'DEBIT' ? -1 : 1) - (b.direction === 'DEBIT' ? -1 : 1));
    const net = entry.lines.reduce(
      (sum, line) => sum + (line.direction === 'CREDIT' ? line.amountCents : -line.amountCents),
      0,
    );
    entry.balanced = entry.lines.length === 2 && net === 0;
    entry.amountCents = Math.max(...entry.lines.map((line) => line.amountCents));
  }

  return [...byGroup.values()];
}

export interface StatementLineRow {
  entry_group: string;
  payment_id: string | null;
  leg: Leg;
  direction: 'DEBIT' | 'CREDIT';
  amount_cents: number;
  created_at: Date;
  counterparty: string | null;
}
