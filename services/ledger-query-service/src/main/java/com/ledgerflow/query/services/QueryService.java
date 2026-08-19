package com.ledgerflow.query.services;

import com.fasterxml.jackson.databind.JsonNode;
import com.ledgerflow.query.repositories.ReadModelRepository;
import com.ledgerflow.query.repositories.ReadModelRepository.Counters;
import com.ledgerflow.query.repositories.ReadModelRepository.ProjectedAccount;
import com.ledgerflow.query.repositories.ReadModelRepository.ProjectedPayment;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * Assembles read responses. Everything here is O(1) or close to it, because
 * the projection already did the arithmetic on the way in - the read side
 * never scans history to answer a question.
 */
@Service
public class QueryService {

  private static final String SOURCE = "redis-read-model";

  public record Balance(String accountId, String name, long balanceCents, String source) {}

  public record Balances(Map<String, Long> balances, String source) {}

  public record Transactions(
      String accountId, List<ProjectedPayment> transactions, String source) {}

  public record Stats(
      String accountId, Counters allTime, Counters today, Counters thisWeek, String source) {}

  public record Activity(List<JsonNode> activity, String source) {}

  public record Pipeline(List<JsonNode> traces) {}

  private final ReadModelRepository readModel;

  public QueryService(ReadModelRepository readModel) {
    this.readModel = readModel;
  }

  public Balance getBalance(String accountId) {
    ProjectedAccount account = readModel.findAccount(accountId);
    if (account == null) return null;
    return new Balance(accountId, account.name(), account.balanceCents(), SOURCE);
  }

  public Balances getBalances(List<String> ids) {
    return new Balances(readModel.findBalances(ids), SOURCE);
  }

  public Transactions getTransactions(String accountId, int limit) {
    return new Transactions(
        accountId, readModel.findPaymentsForAccount(accountId, limit), SOURCE);
  }

  private static Counters empty() {
    return new Counters(0, 0, 0, 0);
  }

  private static Counters sum(List<Counters> buckets) {
    long sentCents = 0;
    long receivedCents = 0;
    long sentCount = 0;
    long receivedCount = 0;
    for (Counters bucket : buckets) {
      sentCents += bucket.sentCents();
      receivedCents += bucket.receivedCents();
      sentCount += bucket.sentCount();
      receivedCount += bucket.receivedCount();
    }
    return new Counters(sentCents, receivedCents, sentCount, receivedCount);
  }

  /** Lifetime totals plus today and this week, from seven day-buckets. */
  public Stats getStats(String accountId) {
    Instant now = Instant.now();
    List<String> days = new ArrayList<>(7);
    for (int offset = 0; offset < 7; offset++) {
      days.add(
          now.minus(offset, ChronoUnit.DAYS).atZone(ZoneOffset.UTC).toLocalDate().toString());
    }

    Counters allTime = readModel.findLifetimeCounters(accountId);
    List<Counters> weekBuckets = new ArrayList<>(days.size());
    for (String day : days) weekBuckets.add(readModel.findDayCounters(accountId, day));

    // days[0] is today, so the first bucket is today's.
    Counters today = weekBuckets.isEmpty() ? empty() : weekBuckets.get(0);

    return new Stats(accountId, allTime, today, sum(weekBuckets), SOURCE);
  }

  public Activity getActivity(int limit) {
    return new Activity(readModel.findActivity(limit), SOURCE);
  }

  public Pipeline getPipelineTraces(int limit) {
    return new Pipeline(readModel.findPipelineTraces(limit));
  }
}
