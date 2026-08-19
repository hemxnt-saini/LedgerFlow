package com.ledgerflow.query.domain;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * An event as it arrives off the topic.
 *
 * One record for every event type rather than a class per type, because that is
 * what the wire actually carries: a `type` discriminator and whichever fields
 * that type fills in. A strict per-type binding would refuse to parse an event
 * this version does not know, and refusing to parse is exactly what must not
 * happen - an unknown event has to be readable enough to be parked with its
 * type named, not dropped as gibberish.
 *
 * Which fields are set by which type:
 *
 * <pre>
 *   every event                    eventId, type, occurredAt
 *   account.created                accountId, name, balanceCents
 *   payment.*                      paymentId, fromAccountId, toAccountId,
 *                                  amountCents, note
 *   payment.held                   holdReasons
 *   payment.failed / .stuck        failureReason
 *   payment.settlement_retrying    failureReason, attempts, maxAttempts, retryInMs
 *   payment.completed              attempts
 * </pre>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record PaymentEvent(
    /** Stable per event, assigned by the producer's outbox. */
    String eventId,
    String type,
    String occurredAt,
    String accountId,
    String name,
    Long balanceCents,
    String paymentId,
    String fromAccountId,
    String toAccountId,
    Long amountCents,
    String note,
    String failureReason,
    Integer attempts,
    List<String> holdReasons) {

  public long amountOrZero() {
    return amountCents == null ? 0 : amountCents;
  }

  public long balanceOrZero() {
    return balanceCents == null ? 0 : balanceCents;
  }
}
