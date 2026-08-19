package com.ledgerflow.payment.config;

import com.zaxxer.hikari.HikariDataSource;
import java.net.URI;
import javax.sql.DataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Builds the pool from `DATABASE_URL`.
 *
 * The variable is a libpq-style URI - `postgres://user:pass@host:port/db` -
 * because that is what every other part of this project, the compose files and
 * the deploy scripts already set. JDBC wants a different shape and the
 * credentials separately, so the translation happens here rather than asking
 * an operator to keep a second copy of the same connection details.
 */
@Configuration
public class DataSourceConfig {

  @Bean
  public DataSource dataSource() {
    URI uri = URI.create(Config.DATABASE_URL);
    String userInfo = uri.getUserInfo() == null ? "" : uri.getUserInfo();
    int separator = userInfo.indexOf(':');

    HikariDataSource dataSource = new HikariDataSource();
    dataSource.setJdbcUrl(
        "jdbc:postgresql://"
            + uri.getHost()
            + (uri.getPort() == -1 ? "" : ":" + uri.getPort())
            + (uri.getPath() == null || uri.getPath().isEmpty() ? "/" : uri.getPath())
            + (uri.getQuery() == null ? "" : "?" + uri.getQuery()));
    dataSource.setUsername(separator < 0 ? userInfo : userInfo.substring(0, separator));
    if (separator >= 0) dataSource.setPassword(userInfo.substring(separator + 1));
    // Four pollers, the request threads, and the reconciliation pass all want a
    // connection; the default of ten is enough for every one of them at once.
    dataSource.setPoolName("payments");
    return dataSource;
  }
}
