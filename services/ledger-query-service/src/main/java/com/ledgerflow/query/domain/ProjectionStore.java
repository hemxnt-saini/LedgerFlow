package com.ledgerflow.query.domain;

import java.util.Map;

/**
 * The only store surface the projection needs, all of it writes.
 *
 * Deliberately write-only. The projection never reads back what it wrote, so it
 * cannot develop opinions about state it did not just receive, and every key it
 * touches is derivable from the event alone.
 *
 * An interface rather than the Redis client itself, so production passes the
 * real thing and the tests pass an in-memory fake - which is what lets the
 * whole projection be tested without a server.
 */
public interface ProjectionStore {

  void hset(String key, Map<String, String> values);

  void hincrby(String key, String field, long increment);

  void lpush(String key, String value);

  void ltrim(String key, long start, long stop);

  void zadd(String key, double score, String member);

  void zremrangebyrank(String key, long start, long stop);

  void expire(String key, long seconds);

  /** Returns 1 if the member was new, 0 if it was already in the set. */
  long sadd(String key, String member);
}
