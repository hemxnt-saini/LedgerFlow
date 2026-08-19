package com.ledgerflow.payment.domain;

/**
 * Where a payment is in its saga. The names are the wire format, the database
 * values and the read model's values all at once, so they must not be renamed.
 */
public enum PaymentStatus {
  /** Sender debited, funds held in the clearing account. */
  PROCESSING,
  /**
   * Authorised but not settled: the funds are secured in clearing and a
   * person has to decide whether to release them. Waiting on a human, not on
   * the system - no worker will move this on its own.
   */
  HELD_FOR_REVIEW,
  /** Receiver credited. Terminal. */
  COMPLETED,
  /** Rejected before any money moved. Terminal. */
  FAILED,
  /** Settlement failed; funds are stranded in clearing, owed back to sender. */
  AWAITING_REFUND,
  /** Stranded funds returned to the sender. Terminal. */
  REFUNDED
}
