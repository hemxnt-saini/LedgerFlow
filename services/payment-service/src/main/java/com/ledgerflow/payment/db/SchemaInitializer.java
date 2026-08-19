package com.ledgerflow.payment.db;

import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.lib.Log;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Creates the schema on boot, then applies the in-place upgrades.
 *
 * Runs while the container is still starting, so it is finished before Tomcat
 * accepts a request and before the first scheduled tick fires. If Postgres
 * cannot be reached the context fails and the process exits, which is what the
 * restart policy is for.
 */
@Component
public class SchemaInitializer implements InitializingBean {

  private final JdbcTemplate jdbc;

  public SchemaInitializer(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @Override
  public void afterPropertiesSet() {
    jdbc.execute(sql("db/schema.sql"));
    jdbc.execute(sql("db/upgrades.sql"));
    Log.info("schema ready");
  }

  private String sql(String path) {
    try (var stream = new ClassPathResource(path).getInputStream()) {
      return new String(stream.readAllBytes(), StandardCharsets.UTF_8)
          .replace("${MAX_PAYMENT_CENTS}", String.valueOf(Config.Controls.MAX_PAYMENT_CENTS))
          .replace("${DAILY_LIMIT_CENTS}", String.valueOf(Config.Controls.DAILY_LIMIT_CENTS))
          .replace("${VELOCITY_MAX}", String.valueOf(Config.Controls.VELOCITY_MAX))
          .replace("${CLEARING_ID}", Config.SystemAccounts.CLEARING_ID)
          .replace("${FUNDING_ID}", Config.SystemAccounts.FUNDING_ID);
    } catch (IOException e) {
      throw new UncheckedIOException("cannot read " + path, e);
    }
  }
}
