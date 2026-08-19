package com.ledgerflow.payment.api.middleware;

import com.ledgerflow.payment.lib.HttpError;
import com.ledgerflow.payment.lib.Log;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * Turns a thrown refusal into the response the caller expects: a status and a
 * stable machine-readable code, always as JSON.
 */
@RestControllerAdvice
public class ErrorAdvice {

  private static ResponseEntity<Map<String, Object>> error(int status, String code) {
    return ResponseEntity.status(status).body(Map.of("error", code));
  }

  @ExceptionHandler(HttpError.class)
  public ResponseEntity<Map<String, Object>> onHttpError(HttpError e) {
    return error(e.status(), e.code());
  }

  /**
   * A JSON API should answer an unknown path in JSON, not with an HTML error
   * page - and an unknown method on a known path was a 404 here before, so it
   * stays one.
   */
  @ExceptionHandler({
    NoHandlerFoundException.class,
    NoResourceFoundException.class,
    HttpRequestMethodNotSupportedException.class
  })
  public ResponseEntity<Map<String, Object>> onNotFound() {
    return error(HttpStatus.NOT_FOUND.value(), "NOT_FOUND");
  }

  /** A malformed body is the caller's mistake, so it must not read as a 500. */
  @ExceptionHandler(HttpMessageNotReadableException.class)
  public ResponseEntity<Map<String, Object>> onUnreadableBody() {
    return error(HttpStatus.BAD_REQUEST.value(), "INVALID_REQUEST_BODY");
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<Map<String, Object>> onUnhandled(Exception e) {
    Log.error("unhandled error", "err", e);
    // The correlation id goes back with the failure so the caller can quote one
    // string and have the whole request found in the logs.
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("error", "INTERNAL_ERROR");
    body.put("correlationId", Log.currentCorrelationId());
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(body);
  }
}
