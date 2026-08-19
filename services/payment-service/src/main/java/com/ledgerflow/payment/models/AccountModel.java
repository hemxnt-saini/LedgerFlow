package com.ledgerflow.payment.models;

import java.time.Instant;

/**
 * The accounts table, and the shape the API hands out.
 *
 * The table is snake_case because that is what Postgres speaks; the DTO is
 * camelCase because that is what the wire speaks. Keeping the translation in
 * one function means no controller has to remember which convention it is
 * holding.
 */
public final class AccountModel {

  private AccountModel() {}

  public record AccountRow(
      String id, String name, long balanceCents, boolean isSystem, Instant createdAt) {}

  public record AccountDto(
      String id, String name, long balanceCents, boolean isSystem, Instant createdAt) {}

  public static AccountDto toAccountDto(AccountRow row) {
    return new AccountDto(row.id(), row.name(), row.balanceCents(), row.isSystem(), row.createdAt());
  }
}
