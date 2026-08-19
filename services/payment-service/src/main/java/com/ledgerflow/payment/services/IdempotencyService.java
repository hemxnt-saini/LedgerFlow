package com.ledgerflow.payment.services;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.domain.Payments;
import com.ledgerflow.payment.lib.HttpError;
import com.ledgerflow.payment.models.PaymentModel.PaymentDto;
import java.time.Duration;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

/**
 * First line of defence against a double charge: a replayed request never
 * reaches Postgres.
 *
 * Redis use #1 of two (see the query service for #2): a short-lived cache of
 * idempotency-key -> response, so a retried POST /payments returns the original
 * result without touching Postgres at all.
 */
@Service
public class IdempotencyService {

  /** What gets cached in Redis under an idempotency key. */
  public record CachedResult(String fingerprint, PaymentDto response) {}

  private final StringRedisTemplate redis;
  private final ObjectMapper mapper;

  public IdempotencyService(StringRedisTemplate redis, ObjectMapper mapper) {
    this.redis = redis;
    this.mapper = mapper;
  }

  private static String cacheKey(String key) {
    return "idempotency:" + key;
  }

  /**
   * Returns the original response if this key has been seen with the *same*
   * request, and throws if it has been seen with a different one. Returning the
   * first payment in that case would be worse than failing - the caller asked a
   * different question and would get a confident wrong answer.
   */
  public PaymentDto findReplay(String key, String fingerprint) {
    String cached = redis.opsForValue().get(cacheKey(key));
    if (cached == null) return null;

    CachedResult entry;
    try {
      entry = mapper.readValue(cached, CachedResult.class);
    } catch (Exception e) {
      // An entry we cannot read is no protection, but it is also not a reason to
      // refuse a payment - treat it as a miss and let the database's UNIQUE
      // constraint be the guard.
      return null;
    }
    if (!entry.fingerprint().equals(fingerprint)) {
      throw HttpError.conflict("IDEMPOTENCY_KEY_REUSED");
    }
    return entry.response();
  }

  /**
   * A client-supplied key is a promise about a specific payment, so it is kept
   * for a day. A derived one is only a double-submit guard, so it expires in a
   * minute - otherwise a legitimate repeat payment of the same amount to the
   * same person would be silently swallowed.
   */
  public void remember(String key, String fingerprint, PaymentDto response) {
    int ttl =
        Payments.isDerivedKey(key)
            ? Config.Idempotency.DERIVED_TTL_SECONDS
            : Config.Idempotency.TTL_SECONDS;
    try {
      redis.opsForValue()
          .set(
              cacheKey(key),
              mapper.writeValueAsString(new CachedResult(fingerprint, response)),
              Duration.ofSeconds(ttl));
    } catch (Exception e) {
      throw new IllegalStateException("cannot cache idempotency entry", e);
    }
  }
}
