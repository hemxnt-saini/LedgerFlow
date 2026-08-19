package com.ledgerflow.query.api.middleware;

import com.ledgerflow.query.lib.Log;
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
 * CORS plus a correlation id for every request. The id is adopted from the
 * caller when present, so a wallet action and the query that follows it share
 * one identifier across both services.
 *
 * Not named RequestContextFilter: Spring Boot auto-configures a bean of exactly
 * that name, and two beans with one name is a refusal to start.
 */
@Component
@Order(1)
public class CorrelationFilter extends OncePerRequestFilter {

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Correlation-Id");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    // Cache the preflight so a burst of calls does not double its request count.
    response.setHeader("Access-Control-Max-Age", "86400");
    response.setHeader("Access-Control-Expose-Headers", "X-Correlation-Id");
    if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
      response.setStatus(HttpServletResponse.SC_NO_CONTENT);
      return;
    }

    String correlationId = Log.correlationIdFrom(request.getHeader("X-Correlation-Id"));
    response.setHeader("X-Correlation-Id", correlationId);

    // The event stream is long-lived; logging it on finish would be misleading,
    // since "finished" means the browser went away.
    boolean isStream = "/events/stream".equals(request.getRequestURI());
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
      if (!isStream) {
        Log.withContext(
            Map.of("correlationId", correlationId),
            () ->
                Log.info(
                    "request",
                    "method",
                    request.getMethod(),
                    "path",
                    request.getRequestURI(),
                    "status",
                    response.getStatus(),
                    "durationMs",
                    System.currentTimeMillis() - startedAt));
      }
    }
  }
}
