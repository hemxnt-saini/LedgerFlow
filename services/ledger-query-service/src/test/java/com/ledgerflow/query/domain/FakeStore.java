package com.ledgerflow.query.domain;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** In-memory stand-in for Redis - no server needed to test the projection. */
final class FakeStore implements ProjectionStore {

  private static final ObjectMapper JSON = new ObjectMapper();
  private static final TypeReference<Map<String, Object>> OBJECT = new TypeReference<>() {};

  private final Map<String, Map<String, String>> hashes = new HashMap<>();
  private final Map<String, List<String>> lists = new HashMap<>();
  private final Map<String, Set<String>> sets = new HashMap<>();
  private final Map<String, Map<String, Double>> zsets = new HashMap<>();
  private final Map<String, Long> expiries = new HashMap<>();

  @Override
  public void hset(String key, Map<String, String> values) {
    hashes.computeIfAbsent(key, k -> new LinkedHashMap<>()).putAll(values);
  }

  @Override
  public void hincrby(String key, String field, long increment) {
    Map<String, String> hash = hashes.computeIfAbsent(key, k -> new LinkedHashMap<>());
    long current = Long.parseLong(hash.getOrDefault(field, "0"));
    hash.put(field, String.valueOf(current + increment));
  }

  @Override
  public void lpush(String key, String value) {
    lists.computeIfAbsent(key, k -> new ArrayList<>()).add(0, value);
  }

  @Override
  public void ltrim(String key, long start, long stop) {
    List<String> list = lists.get(key);
    if (list == null) return;
    int size = list.size();
    int first = (int) (start < 0 ? Math.max(size + start, 0) : Math.min(start, size));
    int last = (int) (stop < 0 ? size + stop : Math.min(stop, size - 1));
    lists.put(
        key, first > last ? new ArrayList<>() : new ArrayList<>(list.subList(first, last + 1)));
  }

  @Override
  public void zadd(String key, double score, String member) {
    zsets.computeIfAbsent(key, k -> new LinkedHashMap<>()).put(member, score);
  }

  @Override
  public void zremrangebyrank(String key, long start, long stop) {
    Map<String, Double> zset = zsets.get(key);
    if (zset == null) return;
    List<Map.Entry<String, Double>> ranked = new ArrayList<>(zset.entrySet());
    ranked.sort(Comparator.comparingDouble(Map.Entry::getValue));
    int size = ranked.size();
    int first = (int) (start < 0 ? Math.max(size + start, 0) : start);
    int last = (int) (stop < 0 ? size + stop : Math.min(stop, size - 1));
    for (int index = first; index <= last && index < size; index++) {
      zset.remove(ranked.get(index).getKey());
    }
  }

  @Override
  public void expire(String key, long seconds) {
    expiries.put(key, seconds);
  }

  @Override
  public long sadd(String key, String member) {
    Set<String> set = sets.computeIfAbsent(key, k -> new LinkedHashSet<>());
    return set.add(member) ? 1 : 0;
  }

  // --- inspection, for the tests -------------------------------------------

  Long balance(String id) {
    Map<String, String> hash = hashes.get(Projector.accountKey(id));
    return hash == null || hash.get("balanceCents") == null
        ? null
        : Long.parseLong(hash.get("balanceCents"));
  }

  Map<String, String> hash(String key) {
    return hashes.get(key);
  }

  Map<String, String> payment(String id) {
    return hashes.get(Projector.paymentKey(id));
  }

  /** The account's payment feed, newest first. */
  List<String> feed(String accountId) {
    Map<String, Double> zset = zsets.get(Projector.paymentIndexKey(accountId));
    if (zset == null) return List.of();
    List<Map.Entry<String, Double>> ranked = new ArrayList<>(zset.entrySet());
    ranked.sort(Map.Entry.<String, Double>comparingByValue().reversed());
    List<String> members = new ArrayList<>(ranked.size());
    for (Map.Entry<String, Double> entry : ranked) members.add(entry.getKey());
    return members;
  }

  List<Map<String, Object>> activity() {
    List<String> raw = lists.getOrDefault(Projector.ACTIVITY_KEY, List.of());
    List<Map<String, Object>> entries = new ArrayList<>(raw.size());
    for (String entry : raw) {
      try {
        entries.add(JSON.readValue(entry, OBJECT));
      } catch (Exception e) {
        throw new IllegalStateException("unreadable activity entry", e);
      }
    }
    return entries;
  }

  Long ttl(String key) {
    return expiries.get(key);
  }
}
