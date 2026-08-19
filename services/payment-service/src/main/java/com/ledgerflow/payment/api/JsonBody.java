package com.ledgerflow.payment.api;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ledgerflow.payment.lib.HttpError;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Reads a JSON request body into a plain map, the way `express.json()` did.
 *
 * Deliberately not `@RequestBody`. Several endpoints here are POSTs with no
 * body at all (refund, approve, run the control), and some clients send one
 * without a JSON content type; binding would answer those with a 415 or a 400
 * about a missing body instead of running the endpoint. So: no JSON content
 * type or nothing to read means an empty body, and a body that claims to be
 * JSON but is not is the one case that fails - as a 400, not a 500.
 */
@Component
public class JsonBody {

  private static final TypeReference<Map<String, Object>> JSON_OBJECT = new TypeReference<>() {};

  private final ObjectMapper mapper;

  public JsonBody(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  public Map<String, Object> read(HttpServletRequest request) {
    String contentType = request.getContentType();
    if (contentType == null || !contentType.toLowerCase().contains("json")) return Map.of();

    String text;
    try {
      text = new String(request.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
    } catch (IOException e) {
      throw HttpError.badRequest("INVALID_REQUEST_BODY");
    }
    if (text.isEmpty()) return Map.of();

    try {
      JsonNode parsed = mapper.readTree(text);
      // Valid JSON that is not an object carries no fields to read, so it is
      // treated as an empty body and the endpoint's own validation answers.
      if (parsed == null || !parsed.isObject()) return Map.of();
      return mapper.convertValue(parsed, JSON_OBJECT);
    } catch (Exception e) {
      throw HttpError.badRequest("INVALID_REQUEST_BODY");
    }
  }
}
