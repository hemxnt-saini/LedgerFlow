package com.ledgerflow.query.lib;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

/**
 * One timestamp format for the whole service: exactly what JavaScript's
 * `Date.toISOString()` produces - UTC, milliseconds, trailing `Z`.
 *
 * It matters that this is fixed rather than "some ISO-8601". The read side
 * slices the first ten characters off `occurredAt` to get a day bucket, the
 * wallet sorts a feed by it, and a browser parses it with `new Date()`. The
 * events on the topic and the rows in Redis were written in this shape before
 * this service spoke Java, and they still are.
 */
public final class Iso {

  private Iso() {}

  private static final DateTimeFormatter FORMAT =
      DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  public static String format(Instant instant) {
    return instant == null ? null : FORMAT.format(instant);
  }

  /** The UTC calendar day an instant falls in, as `YYYY-MM-DD`. */
  public static String day(Instant instant) {
    return format(instant).substring(0, 10);
  }
}
