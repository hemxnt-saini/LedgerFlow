package com.ledgerflow.payment;

import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.lib.Log;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * The entrypoint: bring up the schema, start the background workers, then
 * start listening. Everything it wires together is defined elsewhere - this
 * class is only about lifecycle.
 *
 * The schema runs from {@code SchemaInitializer} while the container is
 * starting, which is before Tomcat accepts a request and before the first
 * scheduled tick fires.
 */
@SpringBootApplication
@EnableScheduling
public class PaymentServiceApplication {

  public static void main(String[] args) {
    try {
      SpringApplication.run(PaymentServiceApplication.class, args);
      Log.info("listening", "port", Config.PORT);
    } catch (Exception e) {
      Log.error("failed to start", "err", e);
      System.exit(1);
    }
  }
}
