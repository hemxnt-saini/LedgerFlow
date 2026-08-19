package com.ledgerflow.payment.api.middleware;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * The frontend is served from a different origin (nginx on :8080), so the
 * browser needs permission to call this service at all.
 *
 * Expose-Headers matters more than it looks: without it `fetch()` cannot read
 * `Idempotent-Replay` or the echoed `Idempotency-Key`, because CORS only
 * surfaces a handful of simple response headers by default. The wallet's
 * "this was replayed, no money moved" message depends on it.
 */
@Component
@Order(2)
public class CorsHeadersFilter extends OncePerRequestFilter {

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
        "Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, X-Correlation-Id");
    // Cache the preflight so a burst of writes does not double its request count.
    response.setHeader("Access-Control-Max-Age", "86400");
    // PUT and DELETE are here because a browser preflight for
    // PUT /accounts/:id/limits is refused without them.
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.setHeader(
        "Access-Control-Expose-Headers",
        "Idempotent-Replay, Idempotency-Key, X-Correlation-Id");

    if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
      response.setStatus(HttpServletResponse.SC_NO_CONTENT);
      return;
    }
    chain.doFilter(request, response);
  }
}
