package com.ledgerflow.payment.lib;

/**
 * An error with an HTTP status and a stable machine-readable code.
 *
 * Services throw these rather than returning result objects, because almost
 * every failure here is a refusal the caller needs to see verbatim
 * (`INSUFFICIENT_FUNDS`, `NOT_REFUNDABLE_FROM_COMPLETED`) rather than an
 * internal condition to be translated. The API layer is the only thing that
 * turns one into a response.
 */
public class HttpError extends RuntimeException {

  private final int status;
  private final String code;

  public HttpError(int status, String code) {
    super(code);
    this.status = status;
    this.code = code;
  }

  public int status() {
    return status;
  }

  public String code() {
    return code;
  }

  public static HttpError badRequest(String code) {
    return new HttpError(400, code);
  }

  public static HttpError notFound(String code) {
    return new HttpError(404, code);
  }

  public static HttpError conflict(String code) {
    return new HttpError(409, code);
  }
}
