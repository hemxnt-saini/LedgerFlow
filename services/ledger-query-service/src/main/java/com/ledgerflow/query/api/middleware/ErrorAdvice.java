package com.ledgerflow.query.api.middleware;

import com.ledgerflow.query.lib.Log;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class ErrorAdvice {

  /** A JSON API should answer an unknown path in JSON, not with an HTML page. */
  @ExceptionHandler({
    NoHandlerFoundException.class,
    NoResourceFoundException.class,
    HttpRequestMethodNotSupportedException.class
  })
  public ResponseEntity<Map<String, Object>> onNotFound() {
    return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "NOT_FOUND"));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<Map<String, Object>> onUnhandled(Exception e) {
    Log.error("unhandled error", "err", e);
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
        .body(Map.of("error", "INTERNAL_ERROR"));
  }
}
