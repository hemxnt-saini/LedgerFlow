package com.ledgerflow.payment.api.middleware;

import com.ledgerflow.payment.lib.Log;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Every request runs inside a correlation id - taken from the caller if they
 * sent one, minted here if not - and it is echoed back so a client can quote
 * it in a bug report.
 *
 * Because the id lives in a thread-local, everything logged downstream carries
 * it without being passed it, including work that happens seconds later in a
 * background worker (the id is written onto the payment row and picked back up
 * there).
 */
@Component
@Order(1)
public class CorrelationFilter extends OncePerRequestFilter {

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String correlationId = Log.correlationIdFrom(request.getHeader("X-Correlation-Id"));
    response.setHeader("X-Correlation-Id", correlationId);

    long startedAt = System.currentTimeMillis();
    try {
      Log.withContext(
          Map.of("correlationId", correlationId),
          () -> {
            try {
              chain.doFilter(request, response);
            } catch (IOException | ServletException e) {
              throw new RuntimeException(e);
            }
            return null;
          });
    } catch (RuntimeException e) {
      if (e.getCause() instanceof IOException io) throw io;
      if (e.getCause() instanceof ServletException servlet) throw servlet;
      throw e;
    } finally {
      Log.withContext(
          Map.of("correlationId", correlationId),
          () -> {
            Object[] fields = {
              "method", request.getMethod(),
              "path", request.getRequestURI(),
              "status", response.getStatus(),
              "durationMs", System.currentTimeMillis() - startedAt
            };
            if (response.getStatus() >= 500) Log.error("request failed", fields);
            else Log.info("request", fields);
          });
    }
  }
}
