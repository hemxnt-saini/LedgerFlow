package com.ledgerflow.query;

import com.ledgerflow.query.config.Config;
import com.ledgerflow.query.lib.Log;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * The entrypoint: start the parking-topic watcher, start projecting, then start
 * listening. Everything it wires together is defined elsewhere - this class is
 * only about lifecycle.
 */
@SpringBootApplication
@EnableScheduling
public class LedgerQueryServiceApplication {

  public static void main(String[] args) {
    try {
      SpringApplication.run(LedgerQueryServiceApplication.class, args);
      Log.info("listening", "port", Config.PORT);
      Log.info("consuming from the beginning", "topic", Config.Kafka.TOPIC);
    } catch (Exception e) {
      Log.error("failed to start", "err", e);
      System.exit(1);
    }
  }
}
