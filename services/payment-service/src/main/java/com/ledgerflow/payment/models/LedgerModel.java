package com.ledgerflow.payment.models;

import com.ledgerflow.payment.domain.Direction;
import com.ledgerflow.payment.domain.Leg;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class LedgerModel {

  private LedgerModel() {}

  /** @param accountName joined from accounts, so the audit trail reads without a second lookup. */
  public record LedgerEntryRow(
      Leg leg,
      Direction direction,
      long amountCents,
      String accountId,
      String accountName,
      Instant createdAt) {}

  public record LedgerEntryDto(
      Leg leg,
      Direction direction,
      long amountCents,
      String accountId,
      String accountName,
      Instant createdAt) {}

  public static LedgerEntryDto toLedgerEntryDto(LedgerEntryRow row) {
    return new LedgerEntryDto(
        row.leg(),
        row.direction(),
        row.amountCents(),
        row.accountId(),
        row.accountName(),
        row.createdAt());
  }

  /** One line of the general journal, still attached to its group. */
  public record JournalLineRow(
      long id,
      String entryGroup,
      String paymentId,
      Leg leg,
      Direction direction,
      long amountCents,
      Instant createdAt,
      String accountId,
      String accountName) {}

  public record JournalLineDto(
      String accountId, String accountName, Direction direction, long amountCents) {}

  /**
   * A journal entry as a unit: the debit, the credit, and what they were for.
   * Reported rather than assumed to be a pair - a group with any other shape is
   * exactly the corruption the trial balance exists to expose, so it has to be
   * displayable.
   */
  public record JournalEntryDto(
      String entryGroup,
      String paymentId,
      Leg leg,
      Instant createdAt,
      long amountCents,
      List<JournalLineDto> lines,
      boolean balanced) {}

  /** Groups flat lines back into journal entries, newest entry first. */
  public static List<JournalEntryDto> toJournalEntries(List<JournalLineRow> rows) {
    Map<String, List<JournalLineRow>> byGroup = new LinkedHashMap<>();
    for (JournalLineRow row : rows) {
      byGroup.computeIfAbsent(row.entryGroup(), key -> new ArrayList<>()).add(row);
    }

    List<JournalEntryDto> entries = new ArrayList<>(byGroup.size());
    for (Map.Entry<String, List<JournalLineRow>> group : byGroup.entrySet()) {
      List<JournalLineRow> groupRows = group.getValue();
      JournalLineRow first = groupRows.get(0);

      // A debit line first reads the way a journal is written.
      List<JournalLineRow> ordered = new ArrayList<>(groupRows);
      ordered.sort(Comparator.comparingInt(row -> row.direction() == Direction.DEBIT ? -1 : 1));

      List<JournalLineDto> lines = new ArrayList<>(ordered.size());
      long net = 0;
      long amountCents = 0;
      for (JournalLineRow row : ordered) {
        lines.add(
            new JournalLineDto(
                row.accountId(), row.accountName(), row.direction(), row.amountCents()));
        net += row.direction() == Direction.CREDIT ? row.amountCents() : -row.amountCents();
        amountCents = Math.max(amountCents, row.amountCents());
      }

      entries.add(
          new JournalEntryDto(
              group.getKey(),
              first.paymentId(),
              first.leg(),
              first.createdAt(),
              amountCents,
              List.copyOf(lines),
              lines.size() == 2 && net == 0));
    }

    return List.copyOf(entries);
  }

  public record StatementLineRow(
      String entryGroup,
      String paymentId,
      Leg leg,
      Direction direction,
      long amountCents,
      Instant createdAt,
      String counterparty) {}
}
