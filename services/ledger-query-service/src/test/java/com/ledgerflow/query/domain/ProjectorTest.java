package com.ledgerflow.query.domain;

import static com.ledgerflow.query.domain.Projector.accountKey;
import static com.ledgerflow.query.domain.Projector.applyEvent;
import static com.ledgerflow.query.domain.Projector.dayOf;
import static com.ledgerflow.query.domain.Projector.dayStatsKey;
import static com.ledgerflow.query.domain.Projector.statsKey;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.entry;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

class ProjectorTest {

  private static final String AT = "2024-03-05T10:00:00.000Z";

  private int nextEventId;

  @BeforeEach
  void resetEventIds() {
    nextEventId = 0;
  }

  private String id() {
    return "evt-" + (++nextEventId);
  }

  private PaymentEvent created(String account, long balanceCents) {
    return new PaymentEvent(
        id(),
        Projector.ACCOUNT_CREATED,
        AT,
        account,
        "acct-" + account,
        balanceCents,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null);
  }

  private PaymentEvent event(String type) {
    return event(type, "pay-1", 2_500, AT, "SETTLEMENT_FAILED_SIMULATED");
  }

  private PaymentEvent event(String type, String paymentId) {
    return event(type, paymentId, 2_500, AT, "SETTLEMENT_FAILED_SIMULATED");
  }

  private PaymentEvent event(String type, long amountCents) {
    return event(type, "pay-1", amountCents, AT, "SETTLEMENT_FAILED_SIMULATED");
  }

  private PaymentEvent event(
      String type, String paymentId, long amountCents, String occurredAt, String failureReason) {
    return new PaymentEvent(
        id(),
        type,
        occurredAt,
        null,
        null,
        null,
        paymentId,
        "a",
        "b",
        amountCents,
        "lunch",
        failureReason,
        null,
        null);
  }

  private void seed(FakeStore store) {
    applyEvent(store, created("a", 10_000));
    applyEvent(store, created("b", 500));
  }

  @Nested
  @DisplayName("account.created")
  class AccountCreated {

    @Test
    @DisplayName("writes the opening balance")
    void writesOpeningBalance() {
      FakeStore store = new FakeStore();
      applyEvent(store, created("a", 10_000));
      assertThat(store.hash(accountKey("a")))
          .containsOnly(entry("id", "a"), entry("name", "acct-a"), entry("balanceCents", "10000"));
    }

    // With more than one partition there is no ordering guarantee between
    // events keyed by account and events keyed by payment. Every balance
    // mutation is therefore a delta, so any arrival order lands on the same
    // number - which is what makes partitioning safe here.
    @Test
    @DisplayName("lands on the same balance whichever order the events arrive in")
    void orderIndependent() {
      PaymentEvent opening = created("a", 10_000);
      PaymentEvent spend = event("payment.initiated", 2_500);

      FakeStore inOrder = new FakeStore();
      applyEvent(inOrder, opening);
      applyEvent(inOrder, spend);

      FakeStore reversed = new FakeStore();
      applyEvent(reversed, spend);
      applyEvent(reversed, opening);

      assertThat(inOrder.balance("a")).isEqualTo(7_500);
      assertThat(reversed.balance("a")).isEqualTo(7_500);
    }

    @Test
    @DisplayName("still records identity when the account event arrives last")
    void identityWhenLate() {
      FakeStore store = new FakeStore();
      applyEvent(store, event("payment.initiated", 100));
      applyEvent(store, created("a", 10_000));
      assertThat(store.hash(accountKey("a")))
          .contains(entry("id", "a"), entry("name", "acct-a"));
      assertThat(store.balance("a")).isEqualTo(9_900);
    }
  }

  // The read model has to be correct at every step of the saga, not just at the
  // end - a wallet showing the wrong balance for one second is a wrong wallet.
  @Nested
  @DisplayName("the saga, projected step by step")
  class SagaStepByStep {

    @Test
    @DisplayName("initiated debits the sender only - the money is in clearing")
    void initiatedDebitsSender() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.initiated"));

      assertThat(store.balance("a")).isEqualTo(7_500);
      assertThat(store.balance("b")).isEqualTo(500); // receiver has NOT been paid yet
      assertThat(store.payment("pay-1")).containsEntry("status", "PROCESSING");
    }

    @Test
    @DisplayName("completed credits the receiver and finishes the payment")
    void completedCreditsReceiver() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.initiated"));
      applyEvent(store, event("payment.completed"));

      assertThat(store.balance("a")).isEqualTo(7_500);
      assertThat(store.balance("b")).isEqualTo(3_000);
      assertThat(store.payment("pay-1")).containsEntry("status", "COMPLETED");
    }

    @Test
    @DisplayName("stuck leaves balances alone - the money is still in clearing")
    void stuckLeavesBalances() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.initiated"));
      applyEvent(store, event("payment.stuck"));

      assertThat(store.balance("a")).isEqualTo(7_500); // still debited
      assertThat(store.balance("b")).isEqualTo(500); // still not paid
      assertThat(store.payment("pay-1"))
          .containsEntry("status", "AWAITING_REFUND")
          .containsEntry("failureReason", "SETTLEMENT_FAILED_SIMULATED");
    }

    @Test
    @DisplayName("refunded returns the sender to exactly where they started")
    void refundedRestoresSender() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.initiated"));
      applyEvent(store, event("payment.stuck"));
      applyEvent(store, event("payment.refunded"));

      assertThat(store.balance("a")).isEqualTo(10_000);
      assertThat(store.balance("b")).isEqualTo(500); // receiver never saw a cent
      assertThat(store.payment("pay-1")).containsEntry("status", "REFUNDED");
    }

    @Test
    @DisplayName("failed touches no balance at all")
    void failedTouchesNoBalance() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.failed", "pay-1", 2_500, AT, "INSUFFICIENT_FUNDS"));

      assertThat(store.balance("a")).isEqualTo(10_000);
      assertThat(store.balance("b")).isEqualTo(500);
      assertThat(store.payment("pay-1"))
          .containsEntry("status", "FAILED")
          .containsEntry("failureReason", "INSUFFICIENT_FUNDS");
    }

    @Test
    @DisplayName("keeps one row per payment, not one per lifecycle event")
    void oneRowPerPayment() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.initiated"));
      applyEvent(store, event("payment.completed"));

      assertThat(store.feed("a")).containsExactly("pay-1");
      assertThat(store.feed("b")).containsExactly("pay-1");
    }

    @Test
    @DisplayName("keeps a payment in place in the feed as its status changes")
    void keepsFeedPosition() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(
          store, event("payment.initiated", "old", 2_500, "2024-03-05T09:00:00.000Z", null));
      applyEvent(
          store, event("payment.initiated", "new", 2_500, "2024-03-05T11:00:00.000Z", null));
      // The older payment settles last - it must not jump to the top.
      applyEvent(
          store, event("payment.completed", "old", 2_500, "2024-03-05T09:00:00.000Z", null));

      assertThat(store.feed("a")).containsExactly("new", "old");
    }

    @Test
    @DisplayName("records every lifecycle step in the global activity log")
    void recordsActivity() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.initiated"));
      applyEvent(store, event("payment.completed"));

      List<Object> types = new ArrayList<>();
      for (Map<String, Object> entry : store.activity()) types.add(entry.get("type"));
      assertThat(types).containsExactly("payment.completed", "payment.initiated");
    }
  }

  @Nested
  @DisplayName("statistics")
  class Statistics {

    @Test
    @DisplayName("counts money only once it has actually arrived")
    void countsOnlyOnArrival() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.initiated"));

      // In flight is not sent.
      assertThat(store.hash(statsKey("a"))).isNull();

      applyEvent(store, event("payment.completed"));
      assertThat(store.hash(statsKey("a")))
          .containsEntry("sentCents", "2500")
          .containsEntry("sentCount", "1");
      assertThat(store.hash(statsKey("b")))
          .containsEntry("receivedCents", "2500")
          .containsEntry("receivedCount", "1");
    }

    @Test
    @DisplayName("does not count a payment that got stuck and refunded")
    void doesNotCountRefunded() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.initiated"));
      applyEvent(store, event("payment.stuck"));
      applyEvent(store, event("payment.refunded"));

      assertThat(store.hash(statsKey("a"))).isNull();
      assertThat(store.hash(statsKey("b"))).isNull();
    }

    @Test
    @DisplayName("buckets by UTC day and expires the bucket")
    void bucketsByDay() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.completed"));

      assertThat(dayOf(AT)).isEqualTo("2024-03-05");
      assertThat(store.hash(dayStatsKey("a", "2024-03-05")))
          .containsEntry("sentCents", "2500");
      assertThat(store.ttl(dayStatsKey("a", "2024-03-05"))).isGreaterThan(0);
      // Lifetime totals must never expire.
      assertThat(store.ttl(statsKey("a"))).isNull();
    }

    @Test
    @DisplayName("accumulates across payments and days")
    void accumulatesAcrossDays() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.completed", "p1", 1_000, AT, null));
      applyEvent(
          store, event("payment.completed", "p2", 250, "2024-03-06T08:00:00.000Z", null));

      assertThat(store.hash(statsKey("a")))
          .containsEntry("sentCents", "1250")
          .containsEntry("sentCount", "2");
      assertThat(store.hash(dayStatsKey("a", "2024-03-05"))).containsEntry("sentCents", "1000");
      assertThat(store.hash(dayStatsKey("a", "2024-03-06"))).containsEntry("sentCents", "250");
    }
  }

  @Nested
  @DisplayName("feed limits")
  class FeedLimits {

    @Test
    @DisplayName("keeps only the most recent 100 payments per account")
    void keepsMostRecentHundred() {
      FakeStore store = new FakeStore();
      seed(store);
      for (int i = 0; i < 120; i++) {
        applyEvent(
            store,
            event(
                "payment.initiated",
                "p" + String.format("%03d", i),
                2_500,
                Instant.parse(AT).plusSeconds(i).toString().replace("Z", ".000Z"),
                null));
      }
      List<String> feed = store.feed("a");
      assertThat(feed).hasSize(100);
      assertThat(feed.get(0)).isEqualTo("p119"); // newest kept
      assertThat(feed).doesNotContain("p000"); // oldest dropped
    }

    @Test
    @DisplayName("caps the global activity log")
    void capsActivityLog() {
      FakeStore store = new FakeStore();
      seed(store);
      for (int i = 0; i < 250; i++) {
        applyEvent(store, event("payment.initiated", "p" + i));
      }
      assertThat(store.activity()).hasSize(200);
    }
  }

  // Delivery is at-least-once from both ends - the outbox can re-publish after
  // a crash, and Kafka can redeliver on a rebalance. Applying twice would
  // invent money, so these are the tests that matter most.
  @Nested
  @DisplayName("at-least-once delivery")
  class AtLeastOnceDelivery {

    @Test
    @DisplayName("ignores a redelivered event instead of double-counting")
    void ignoresRedelivered() {
      FakeStore store = new FakeStore();
      seed(store);
      PaymentEvent initiated = event("payment.initiated");

      assertThat(applyEvent(store, initiated)).isTrue();
      assertThat(applyEvent(store, initiated)).isFalse();
      assertThat(applyEvent(store, initiated)).isFalse();

      assertThat(store.balance("a")).isEqualTo(7_500);
      assertThat(store.activity()).hasSize(1);
    }

    @Test
    @DisplayName("does not double-count a redelivered completion, or its statistics")
    void ignoresRedeliveredCompletion() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.initiated"));
      PaymentEvent completed = event("payment.completed");
      applyEvent(store, completed);
      applyEvent(store, completed);

      assertThat(store.balance("b")).isEqualTo(3_000);
      assertThat(store.hash(statsKey("b")))
          .containsEntry("receivedCents", "2500")
          .containsEntry("receivedCount", "1");
    }

    @Test
    @DisplayName("treats two distinct events with identical payloads as two payments")
    void distinctEventsAreDistinct() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.initiated", "x"));
      applyEvent(store, event("payment.initiated", "y"));

      assertThat(store.balance("a")).isEqualTo(5_000);
      assertThat(store.feed("a")).hasSize(2);
    }

    @Test
    @DisplayName("replaying the whole stream is a no-op on an already-built read model")
    void replayIsNoOp() {
      List<PaymentEvent> stream =
          List.of(
              created("a", 10_000),
              created("b", 500),
              event("payment.initiated"),
              event("payment.completed"));
      FakeStore store = new FakeStore();
      for (PaymentEvent e : stream) applyEvent(store, e);
      List<Object> snapshot =
          List.of(store.balance("a"), store.balance("b"), store.activity().size());

      for (PaymentEvent e : stream) applyEvent(store, e);
      assertThat(List.of(store.balance("a"), store.balance("b"), store.activity().size()))
          .isEqualTo(snapshot);
    }

    @Test
    @DisplayName("rebuilds identical state when replayed into an empty read model")
    void rebuildsIdenticalState() {
      List<PaymentEvent> stream =
          List.of(
              created("a", 10_000),
              created("b", 500),
              event("payment.initiated"),
              event("payment.stuck"),
              event("payment.refunded"));

      FakeStore original = new FakeStore();
      for (PaymentEvent e : stream) applyEvent(original, e);
      FakeStore rebuilt = new FakeStore();
      for (PaymentEvent e : stream) applyEvent(rebuilt, e);

      assertThat(rebuilt.balance("a")).isEqualTo(original.balance("a"));
      assertThat(rebuilt.balance("b")).isEqualTo(original.balance("b"));
      assertThat(rebuilt.payment("pay-1")).isEqualTo(original.payment("pay-1"));
      assertThat(rebuilt.activity()).isEqualTo(original.activity());
    }
  }

  @Nested
  @DisplayName("the trust boundary")
  class TrustBoundary {

    @Test
    @DisplayName("knows which types it can project")
    void knowsKnownTypes() {
      assertThat(Projector.isKnownEventType("account.created")).isTrue();
      assertThat(Projector.isKnownEventType("payment.initiated")).isTrue();
      assertThat(Projector.isKnownEventType("payment.held")).isTrue();
      assertThat(Projector.isKnownEventType("payment.approved")).isTrue();
      assertThat(Projector.isKnownEventType("payment.settlement_retrying")).isTrue();
      assertThat(Projector.isKnownEventType("payment.completed")).isTrue();
      assertThat(Projector.isKnownEventType("payment.failed")).isTrue();
      assertThat(Projector.isKnownEventType("payment.stuck")).isTrue();
      assertThat(Projector.isKnownEventType("payment.refunded")).isTrue();
      // Published by the write side, and deliberately not projected.
      assertThat(Projector.isKnownEventType("reconciliation.drift_detected")).isFalse();
      assertThat(Projector.isKnownEventType("something.new")).isFalse();
    }

    @Test
    @DisplayName("reads a timestamp the same way whether screening or scoring it")
    void parsesTimestamps() {
      assertThat(Projector.parseTimestamp(AT)).isEqualTo(Instant.parse(AT).toEpochMilli());
      assertThat(Projector.parseTimestamp("2024-03-05T10:00:00Z")).isNotNull();
      assertThat(Projector.parseTimestamp("not a date")).isNull();
      assertThat(Projector.parseTimestamp(null)).isNull();
    }

    @Test
    @DisplayName("a held payment is authorised, so it debits the sender")
    void heldDebitsSender() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.held"));

      assertThat(store.balance("a")).isEqualTo(7_500);
      assertThat(store.payment("pay-1")).containsEntry("status", "HELD_FOR_REVIEW");
    }

    @Test
    @DisplayName("approving a held payment moves no money, only its status")
    void approvedMovesNoMoney() {
      FakeStore store = new FakeStore();
      seed(store);
      applyEvent(store, event("payment.held"));
      applyEvent(store, event("payment.approved"));

      assertThat(store.balance("a")).isEqualTo(7_500);
      assertThat(store.payment("pay-1")).containsEntry("status", "PROCESSING");
    }
  }
}
