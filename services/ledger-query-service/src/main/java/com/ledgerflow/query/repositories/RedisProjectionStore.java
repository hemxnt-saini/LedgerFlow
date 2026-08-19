package com.ledgerflow.query.repositories;

import com.ledgerflow.query.domain.ProjectionStore;
import java.time.Duration;
import java.util.Map;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Repository;

/**
 * The real store behind the projection.
 *
 * Redis use #2 of two (see the payment service for #1): this is the whole
 * database of the read side. There is no Postgres here - every value served was
 * projected from a Kafka event and can be deleted and rebuilt from the log at
 * any time.
 */
@Repository
public class RedisProjectionStore implements ProjectionStore {

  private final StringRedisTemplate redis;

  public RedisProjectionStore(StringRedisTemplate redis) {
    this.redis = redis;
  }

  @Override
  public void hset(String key, Map<String, String> values) {
    redis.opsForHash().putAll(key, values);
  }

  @Override
  public void hincrby(String key, String field, long increment) {
    redis.opsForHash().increment(key, field, increment);
  }

  @Override
  public void lpush(String key, String value) {
    redis.opsForList().leftPush(key, value);
  }

  @Override
  public void ltrim(String key, long start, long stop) {
    redis.opsForList().trim(key, start, stop);
  }

  @Override
  public void zadd(String key, double score, String member) {
    redis.opsForZSet().add(key, member, score);
  }

  @Override
  public void zremrangebyrank(String key, long start, long stop) {
    redis.opsForZSet().removeRange(key, start, stop);
  }

  @Override
  public void expire(String key, long seconds) {
    redis.expire(key, Duration.ofSeconds(seconds));
  }

  @Override
  public long sadd(String key, String member) {
    Long added = redis.opsForSet().add(key, member);
    return added == null ? 0 : added;
  }
}
