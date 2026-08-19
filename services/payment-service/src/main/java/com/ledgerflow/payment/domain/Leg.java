package com.ledgerflow.payment.domain;

/**
 * Which step of the saga a journal entry belongs to.
 *
 * FUNDING issues money into the system when a wallet is opened. The other
 * three are the legs of a payment, and a payment's history is readable from
 * this column alone: AUTHORISE + SETTLE completed, AUTHORISE + COMPENSATE was
 * refunded, AUTHORISE on its own is still in flight.
 */
public enum Leg {
  FUNDING,
  AUTHORISE,
  SETTLE,
  COMPENSATE
}
