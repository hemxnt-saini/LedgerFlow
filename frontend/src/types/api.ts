/** Shapes the two backends actually return. Hand-written to match the DTOs. */

export type PaymentStatus =
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'AWAITING_REFUND'
  | 'REFUNDED';

export type SimulateMode = 'NONE' | 'TRANSIENT' | 'PERMANENT';

export type Leg = 'FUNDING' | 'AUTHORISE' | 'SETTLE' | 'COMPENSATE';

export interface Account {
  id: string;
  name: string;
  balanceCents: number;
  isSystem: boolean;
  createdAt: string;
}

export interface LedgerEntry {
  leg: Leg;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: number;
  accountId: string;
  accountName: string;
  createdAt: string;
}

export interface Payment {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  note: string | null;
  status: PaymentStatus;
  failureReason: string | null;
  simulateMode: SimulateMode;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

export type PaymentWithLedger = Payment & { ledger: LedgerEntry[] };

/** The read model's view of a payment - one row whose status changes. */
export interface ProjectedPayment {
  paymentId: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  note: string | null;
  status: PaymentStatus;
  failureReason: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/** One row of the trial balance: an account's debit and credit columns. */
export interface TrialBalanceRow {
  accountId: string;
  accountName: string;
  isSystem: boolean;
  debitsCents: number;
  creditsCents: number;
  /** Credits minus debits - what the journal says this account holds. */
  ledgerBalanceCents: number;
  /** What the accounts table claims. The two must agree. */
  cachedBalanceCents: number;
  matches: boolean;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebitsCents: number;
  totalCreditsCents: number;
  differenceCents: number;
  balanced: boolean;
  systemTotalCents: number;
  zeroSum: boolean;
  mismatchedAccounts: number;
}

export interface JournalLine {
  accountId: string;
  accountName: string;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: number;
}

/** A journal entry as a unit: one debit, one credit, and what they were for. */
export interface JournalEntry {
  entryGroup: string;
  paymentId: string | null;
  leg: Leg;
  createdAt: string;
  amountCents: number;
  lines: JournalLine[];
  balanced: boolean;
}

export interface StatementLine {
  entryGroup: string;
  paymentId: string | null;
  leg: Leg;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: number;
  createdAt: string;
  counterpartyName: string | null;
  /** Signed effect on this account: credits add, debits subtract. */
  changeCents: number;
  runningCents: number;
}

export interface AccountStatement {
  accountId: string;
  accountName: string;
  cachedBalanceCents: number;
  matches: boolean;
  openingCents: number;
  closingCents: number;
  lines: StatementLine[];
}

export interface Counters {
  sentCents: number;
  receivedCents: number;
  sentCount: number;
  receivedCount: number;
}

export interface Stats {
  accountId: string;
  allTime: Counters;
  today: Counters;
  thisWeek: Counters;
}

export type EventType =
  | 'account.created'
  | 'payment.initiated'
  | 'payment.settlement_retrying'
  | 'payment.completed'
  | 'payment.failed'
  | 'payment.stuck'
  | 'payment.refunded'
  | 'reconciliation.drift_detected';

export interface ActivityEntry {
  eventId: string;
  type: EventType;
  paymentId: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  note: string;
  failureReason: string | null;
  occurredAt: string;
}

/** Measured, not simulated - each stamp is taken at a real hop. */
export interface PipelineTrace {
  eventId: string;
  type: EventType;
  paymentId: string | null;
  partition: number;
  offset: string;
  committedAt: string;
  publishedAt: string;
  receivedAt: string;
  projectedAt: string;
  stages: {
    outboxMs: number;
    transportMs: number;
    projectionMs: number;
    totalMs: number;
  };
}

/** What arrives on the SSE `payment-event` frame. */
export interface StreamEvent {
  event: ActivityEntry & { accountId?: string };
  trace: PipelineTrace;
}

export interface PartitionView {
  partition: number;
  low: number;
  high: number;
  messages: number;
  committed: number | null;
  lag: number;
}

export interface TopicView {
  topic: string;
  partitions: PartitionView[];
  messages: number;
  lag: number;
}

export interface GroupView {
  groupId: string;
  state: string;
  members: { memberId: string; clientId: string; host: string; assignment: string[] }[];
}

export interface KafkaOverview {
  topics: TopicView[];
  groups: GroupView[];
  mainTopic: string;
  dlqTopic: string;
  consumerPaused: boolean;
  subscribers: number;
}

export interface DeadLetter {
  dlqId: string;
  reason: 'UNPARSEABLE' | 'MALFORMED' | 'UNKNOWN_TYPE';
  detail: string;
  sourceTopic: string;
  partition: number;
  offset: string;
  key: string | null;
  payload: string;
  failedAt: string;
  replayedAt?: string;
}
