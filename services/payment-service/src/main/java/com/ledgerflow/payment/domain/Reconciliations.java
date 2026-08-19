package com.ledgerflow.payment.domain;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/**
 * Pure reconciliation logic: the control that proves the books are intact.
 *
 * An account's `balance_cents` is a denormalised cache. The ledger is the
 * truth. Nothing stops the two drifting apart - a bug, a partial write, a
 * hand-edited row - and a payments system that cannot detect that is a
 * payments system that will one day be quietly wrong. So an independent pass
 * recomputes every balance from the ledger and compares.
 *
 * No Spring, no JDBC, no Redis, no Kafka. The caller does the querying and
 * hands over plain data; every rule below is a pure function of that data.
 */
public final class Reconciliations {

  private Reconciliations() {}

  public enum Severity {
    OK,
    WARN,
    DRIFT
  }

  public enum FindingCode {
    /** An account's cached balance disagrees with its ledger history. */
    BALANCE_DRIFT,
    /** All balances together no longer sum to zero: money entered or left. */
    SYSTEM_NOT_ZERO_SUM,
    /** The clearing account is not holding exactly what is in flight. */
    CLEARING_MISMATCH,
    /** A journal entry is not a balanced pair of lines. */
    UNBALANCED_JOURNAL,
    /** The read model disagrees with the write side and cannot blame lag. */
    READ_MODEL_DRIFT,
    /** The read model disagrees, but there is unfinished work to explain it. */
    READ_MODEL_LAG
  }

  /**
   * A finding, with only the fields that apply to it.
   *
   * Absent fields are left out of the JSON rather than sent as null: the UI
   * decides whether to print "expected X, found Y" by asking whether those
   * numbers are there at all, and a null would read as a number of zero.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Finding(
      FindingCode code,
      Severity severity,
      String detail,
      String accountId,
      String accountName,
      Long expectedCents,
      Long actualCents,
      Long driftCents) {

    public static Finding of(FindingCode code, Severity severity, String detail) {
      return new Finding(code, severity, detail, null, null, null, null, null);
    }

    public Finding withAccount(String id, String name) {
      return new Finding(code, severity, detail, id, name, expectedCents, actualCents, driftCents);
    }

    public Finding withAmounts(long expectedCents, long actualCents, long driftCents) {
      return new Finding(
          code, severity, detail, accountId, accountName, expectedCents, actualCents, driftCents);
    }
  }

  public record AccountSnapshot(String id, String name, long balanceCents, boolean isSystem) {}

  public record LedgerTotals(long creditsCents, long debitsCents) {}

  /** A journal entry that failed the "exactly one debit, one credit" rule. */
  public record UnbalancedJournal(String entryGroup, int lineCount, long netCents) {}

  /**
   * @param ledger accountId -&gt; summed ledger lines. Absent means the account
   *     has none.
   * @param inFlightCents sum of every payment whose money is sitting in
   *     clearing.
   * @param readModel accountId -&gt; balance according to Redis. Null to skip the
   *     check.
   * @param readModelMayLag true when there is unpublished or unsettled work, so
   *     a read model that disagrees is merely behind rather than wrong.
   *     Eventual consistency is the design, so it must not be reported as a
   *     fault.
   */
  public record ReconciliationInput(
      List<AccountSnapshot> accounts,
      Map<String, LedgerTotals> ledger,
      List<UnbalancedJournal> unbalancedJournals,
      String clearingAccountId,
      long inFlightCents,
      Map<String, Long> readModel,
      boolean readModelMayLag) {}

  /**
   * @param driftCents total absolute disagreement found, in cents. Zero is the
   *     only good number.
   */
  public record ReconciliationReport(
      Severity status, List<Finding> findings, int checkedAccounts, long driftCents) {}

  /** Ledger truth for one account: what it received minus what it sent. */
  public static long ledgerBalance(LedgerTotals totals) {
    return totals == null ? 0 : totals.creditsCents() - totals.debitsCents();
  }

  public static ReconciliationReport reconcile(ReconciliationInput input) {
    List<Finding> findings = new ArrayList<>();
    long driftCents = 0;

    // 1. Every account's cached balance must equal its ledger history.
    for (AccountSnapshot account : input.accounts()) {
      long expected = ledgerBalance(input.ledger().get(account.id()));
      if (expected != account.balanceCents()) {
        Finding finding =
            Finding.of(
                    FindingCode.BALANCE_DRIFT,
                    Severity.DRIFT,
                    account.name() + " balance does not match its ledger history")
                .withAccount(account.id(), account.name())
                .withAmounts(expected, account.balanceCents(), account.balanceCents() - expected);
        findings.add(finding);
        driftCents += Math.abs(finding.driftCents());
      }
    }

    // 2. Because opening a wallet is funded from the funding account, the whole
    //    system is a closed set of books: every balance added together is zero.
    //    Any other number means money was created or destroyed.
    long systemTotal = input.accounts().stream().mapToLong(AccountSnapshot::balanceCents).sum();
    if (systemTotal != 0) {
      findings.add(
          Finding.of(
                  FindingCode.SYSTEM_NOT_ZERO_SUM,
                  Severity.DRIFT,
                  "All balances together do not sum to zero - money was created or destroyed")
              .withAmounts(0, systemTotal, systemTotal));
      driftCents += Math.abs(systemTotal);
    }

    // 3. The clearing account holds in-flight money and nothing else.
    AccountSnapshot clearing =
        input.accounts().stream()
            .filter(account -> account.id().equals(input.clearingAccountId()))
            .findFirst()
            .orElse(null);
    if (clearing != null && clearing.balanceCents() != input.inFlightCents()) {
      long drift = clearing.balanceCents() - input.inFlightCents();
      findings.add(
          Finding.of(
                  FindingCode.CLEARING_MISMATCH,
                  Severity.DRIFT,
                  "Clearing account is not holding exactly the in-flight payments")
              .withAccount(clearing.id(), clearing.name())
              .withAmounts(input.inFlightCents(), clearing.balanceCents(), drift));
      driftCents += Math.abs(drift);
    }

    // 4. Double entry itself: each journal is one debit and one credit, netting
    //    to zero. A group that fails this is a half-written transaction.
    for (UnbalancedJournal journal : input.unbalancedJournals()) {
      findings.add(
          new Finding(
              FindingCode.UNBALANCED_JOURNAL,
              Severity.DRIFT,
              "Journal "
                  + journal.entryGroup()
                  + " has "
                  + journal.lineCount()
                  + " lines netting "
                  + journal.netCents(),
              null,
              null,
              null,
              null,
              journal.netCents()));
      driftCents += Math.abs(journal.netCents());
    }

    // 5. Cross-store: does the read model agree? Only a fault if nothing is
    //    still in flight to explain it.
    if (input.readModel() != null) {
      for (AccountSnapshot account : input.accounts()) {
        if (account.isSystem()) continue; // not projected into the read model
        Long projected = input.readModel().get(account.id());
        if (projected == null || projected == account.balanceCents()) continue;

        boolean lagging = input.readModelMayLag();
        findings.add(
            Finding.of(
                    lagging ? FindingCode.READ_MODEL_LAG : FindingCode.READ_MODEL_DRIFT,
                    lagging ? Severity.WARN : Severity.DRIFT,
                    lagging
                        ? account.name() + " read model is behind, with work still in flight"
                        : account.name()
                            + " read model disagrees with nothing left to explain it")
                .withAccount(account.id(), account.name())
                .withAmounts(account.balanceCents(), projected, projected - account.balanceCents()));
        if (!lagging) driftCents += Math.abs(projected - account.balanceCents());
      }
    }

    Severity status =
        findings.stream().anyMatch(finding -> finding.severity() == Severity.DRIFT)
            ? Severity.DRIFT
            : findings.stream().anyMatch(finding -> finding.severity() == Severity.WARN)
                ? Severity.WARN
                : Severity.OK;

    return new ReconciliationReport(
        status, List.copyOf(findings), input.accounts().size(), driftCents);
  }

  /** The distinct codes in a report, in the order they were first seen. */
  public static List<FindingCode> distinctCodes(List<Finding> findings) {
    return List.copyOf(new LinkedHashSet<>(findings.stream().map(Finding::code).toList()));
  }
}
