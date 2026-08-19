package com.ledgerflow.payment.db;

import java.util.function.Supplier;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Runs a body inside a single transaction; rolls back on any throw.
 *
 * This is what makes the outbox pattern work: the business rows and the event
 * row are written through the same connection, so they commit together or not
 * at all. There is no window in which one exists without the other.
 *
 * Repositories do not take a connection or a template - Spring binds one to the
 * thread for the duration, so the same repository method works inside and
 * outside a transaction and the caller decides which.
 */
@Component
public class Tx {

  private final TransactionTemplate template;

  public Tx(PlatformTransactionManager transactionManager) {
    this.template = new TransactionTemplate(transactionManager);
  }

  public <T> T inTransaction(Supplier<T> body) {
    return template.execute(status -> body.get());
  }

  public void inTransaction(Runnable body) {
    template.executeWithoutResult(status -> body.run());
  }
}
