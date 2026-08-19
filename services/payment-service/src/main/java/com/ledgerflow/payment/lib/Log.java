package com.ledgerflow.payment.lib;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.ledgerflow.payment.config.Config;
import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;

/**
 * Structured logging with a correlation id that survives the hop through
 * Kafka.
 *
 * The point is not JSON. The point is that one payment produces log lines in
 * the payment service, in three different background workers, and again in
 * the query service after a trip through a broker - and all of them carry the
 * same `correlationId`, so the whole journey is one grep.
 *
 * The id lives in a thread-local rather than being passed down through every
 * method signature. Anything running inside a request or a scheduled tick
 * picks it up automatically. (The TypeScript version used
 * AsyncLocalStorage for the same reason; a thread-local is the direct
 * equivalent for a thread-per-request server.)
 *
 * No logging framework: this is a few lines around stdout, and shipping and
 * sampling would be the only things that could earn one its place.
 */
public final class Log {

  private Log() {}

  public enum Level {
    DEBUG(10),
    INFO(20),
    WARN(30),
    ERROR(40);

    final int weight;

    Level(int weight) {
      this.weight = weight;
    }
  }

  private static final int MIN_LEVEL = minLevel(Config.LOG_LEVEL);
  private static final String SERVICE = Config.SERVICE_NAME;

  private static int minLevel(String configured) {
    try {
      return Level.valueOf(configured.trim().toUpperCase()).weight;
    } catch (IllegalArgumentException e) {
      return Level.INFO.weight;
    }
  }

  /** Errors are logged as an object, not a stack-trace-shaped string. */
  private static final ObjectMapper MAPPER =
      new ObjectMapper()
          .registerModule(
              new SimpleModule()
                  .addSerializer(
                      Throwable.class,
                      new JsonSerializer<Throwable>() {
                        @Override
                        public void serialize(
                            Throwable value, JsonGenerator gen, SerializerProvider serializers)
                            throws IOException {
                          gen.writeStartObject();
                          gen.writeStringField("name", value.getClass().getSimpleName());
                          gen.writeStringField("message", String.valueOf(value.getMessage()));
                          gen.writeEndObject();
                        }
                      }));

  private static final ThreadLocal<Map<String, Object>> CONTEXT = new ThreadLocal<>();

  public static Map<String, Object> currentContext() {
    Map<String, Object> context = CONTEXT.get();
    return context == null ? Map.of() : context;
  }

  public static String currentCorrelationId() {
    Object id = currentContext().get("correlationId");
    return id == null ? null : String.valueOf(id);
  }

  public static String newCorrelationId() {
    return UUID.randomUUID().toString();
  }

  /** Runs the body with this context attached to every log line it produces. */
  public static void withContext(Map<String, Object> context, Runnable body) {
    withContext(
        context,
        () -> {
          body.run();
          return null;
        });
  }

  public static <T> T withContext(Map<String, Object> context, Callable<T> body) {
    Map<String, Object> previous = CONTEXT.get();
    Map<String, Object> merged = new LinkedHashMap<>();
    if (previous != null) merged.putAll(previous);
    merged.putAll(context);
    CONTEXT.set(merged);
    try {
      return body.call();
    } catch (RuntimeException | Error e) {
      throw e;
    } catch (Exception e) {
      throw new RuntimeException(e);
    } finally {
      if (previous == null) CONTEXT.remove();
      else CONTEXT.set(previous);
    }
  }

  /** Correlation id for a request, taken from the caller or minted here. */
  public static String correlationIdFrom(String header) {
    if (header == null) return newCorrelationId();
    String trimmed = header.trim();
    return trimmed.isEmpty() ? newCorrelationId() : trimmed;
  }

  public static void debug(String message, Object... fields) {
    emit(Level.DEBUG, message, fields);
  }

  public static void info(String message, Object... fields) {
    emit(Level.INFO, message, fields);
  }

  public static void warn(String message, Object... fields) {
    emit(Level.WARN, message, fields);
  }

  public static void error(String message, Object... fields) {
    emit(Level.ERROR, message, fields);
  }

  /** @param fields alternating key/value pairs, e.g. {@code "port", 4000}. */
  private static void emit(Level level, String message, Object... fields) {
    if (level.weight < MIN_LEVEL) return;

    Map<String, Object> line = new LinkedHashMap<>();
    line.put("ts", Iso.format(Instant.now()));
    line.put("level", level.name().toLowerCase());
    line.put("svc", SERVICE);
    line.put("msg", message);
    line.putAll(currentContext());
    for (int i = 0; i + 1 < fields.length; i += 2) {
      line.put(String.valueOf(fields[i]), fields[i + 1]);
    }

    // One JSON object per line: greppable with jq, parseable by anything, and
    // never interleaved halfway through a message the way multi-line output is.
    String text;
    try {
      text = MAPPER.writeValueAsString(line);
    } catch (Exception e) {
      text = "{\"level\":\"error\",\"svc\":\"" + SERVICE + "\",\"msg\":\"log serialisation failed\"}";
    }
    if (level == Level.ERROR) System.err.println(text);
    else System.out.println(text);
  }
}
