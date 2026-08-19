package com.ledgerflow.payment.db;

import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/** The three column shapes every row mapper here has to read. */
public final class Rows {

  private Rows() {}

  /** timestamptz, or null. */
  public static Instant instant(ResultSet rs, String column) throws SQLException {
    OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
    return value == null ? null : value.toInstant();
  }

  /** A Postgres TEXT[], never null - an absent array reads as empty. */
  public static List<String> strings(ResultSet rs, String column) throws SQLException {
    Array array = rs.getArray(column);
    if (array == null) return List.of();
    String[] values = (String[]) array.getArray();
    return values == null ? List.of() : List.of(values);
  }

  /** int, or null. */
  public static Integer integer(ResultSet rs, String column) throws SQLException {
    int value = rs.getInt(column);
    return rs.wasNull() ? null : value;
  }

  /**
   * A uuid parameter, or a typed null.
   *
   * The driver sends a String as varchar, which Postgres will not silently
   * compare to a uuid column, so ids are always bound as UUID objects.
   */
  public static UUID uuid(String value) {
    return value == null ? null : UUID.fromString(value);
  }
}
