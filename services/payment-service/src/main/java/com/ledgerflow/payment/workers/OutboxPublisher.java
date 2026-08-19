package com.ledgerflow.payment.workers;

import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.db.Tx;
import com.ledgerflow.payment.lib.Log;
import com.ledgerflow.payment.repositories.OutboxRepository;
import com.ledgerflow.payment.repositories.OutboxRepository.OutboxRow;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.header.internals.RecordHeader;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Publishes unpublished outbox rows to Kafka.
 *
 * Delivery is at-least-once: a crash between the send and the COMMIT re-sends
 * those rows. That is why every event carries an id assigned when it was
 * enqueued - a re-publish carries the same id, and the read model applies it
 * once.
 *
 * A tick that throws is logged and retried on the next beat. The whole loop is
 * built on `FOR UPDATE SKIP LOCKED`, so a failed attempt simply leaves the row
 * for the next pass - which is why killing the broker does not stop payments
 * being accepted.
 */
@Component
public class OutboxPublisher {

  private final Tx tx;
  private final OutboxRepository outbox;
  private final KafkaTemplate<String, String> kafka;

  public OutboxPublisher(Tx tx, OutboxRepository outbox, KafkaTemplate<String, String> kafka) {
    this.tx = tx;
    this.outbox = outbox;
    this.kafka = kafka;
  }

  @Scheduled(fixedDelayString = "${OUTBOX_POLL_MS:400}")
  public void tick() {
    try {
      // Drain in batches so a backlog clears fast instead of one batch a tick.
      int sent = 0;
      int batch;
      do {
        batch = publishBatch();
        sent += batch;
      } while (batch == Config.Outbox.BATCH_SIZE);
      if (sent > 0) Log.info("published outbox events", "count", sent);
    } catch (Exception e) {
      Log.error("poller tick failed, retrying next beat", "poller", "outbox", "err", e);
    }
  }

  /** Publishes up to one batch of rows. Returns how many were sent. */
  private int publishBatch() {
    return tx.inTransaction(
        () -> {
          List<OutboxRow> rows = outbox.claimUnpublished(Config.Outbox.BATCH_SIZE);
          if (rows.isEmpty()) return 0;

          // A header, not the payload: the payload was fixed when the event
          // was enqueued, and this is when it actually left. The gap between
          // the two is real outbox latency.
          String publishedAt = String.valueOf(System.currentTimeMillis());

          List<CompletableFuture<?>> sends = new ArrayList<>(rows.size());
          List<Long> ids = new ArrayList<>(rows.size());
          for (OutboxRow row : rows) {
            List<Header> headers =
                List.of(
                    new RecordHeader("publishedAt", publishedAt.getBytes(StandardCharsets.UTF_8)),
                    new RecordHeader(
                        "correlationId",
                        String.valueOf(row.payload().getOrDefault("correlationId", ""))
                            .getBytes(StandardCharsets.UTF_8)));

            sends.add(
                kafka.send(
                    new ProducerRecord<>(
                        Config.Kafka.TOPIC, null, keyOf(row), row.raw(), headers)));
            ids.add(row.id());
          }

          // Every record has to be acknowledged before the rows are marked
          // published and the transaction commits. A failure here throws, the
          // transaction rolls back, and the same rows are picked up next tick.
          for (CompletableFuture<?> send : sends) send.join();

          outbox.markPublished(ids);
          return rows.size();
        });
  }

  /**
   * Keyed by payment or account id, so every event about one payment lands on
   * the same partition and keeps its order.
   */
  private static String keyOf(OutboxRow row) {
    Object paymentId = row.payload().get("paymentId");
    if (paymentId != null) return String.valueOf(paymentId);
    Object accountId = row.payload().get("accountId");
    if (accountId != null) return String.valueOf(accountId);
    return String.valueOf(row.id());
  }
}
