package com.ledgerflow.payment.domain;

/** How settlement is made to fail on purpose, for demonstrating the saga. */
public enum SimulateMode {
  NONE,
  /** Heals before the retries run out, so the payment completes. */
  TRANSIENT,
  /** Never heals, so the payment ends in compensation. */
  PERMANENT
}
