package com.ledgerflow.payment.api.routes;

import com.ledgerflow.payment.api.JsonBody;
import com.ledgerflow.payment.api.Validation;
import com.ledgerflow.payment.api.Validation.ValidatedTransfer;
import com.ledgerflow.payment.config.Config;
import com.ledgerflow.payment.lib.HttpError;
import com.ledgerflow.payment.models.PaymentModel.PaymentDto;
import com.ledgerflow.payment.services.PaymentService;
import com.ledgerflow.payment.services.PaymentService.InitiatePaymentInput;
import com.ledgerflow.payment.services.PaymentService.InitiatePaymentResult;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class PaymentController {

  private final PaymentService payments;
  private final JsonBody jsonBody;

  public PaymentController(PaymentService payments, JsonBody jsonBody) {
    this.payments = payments;
    this.jsonBody = jsonBody;
  }

  /** The review queue: payments whose funds are held pending a decision. */
  @GetMapping("/payments/reviews")
  public Map<String, Object> reviews(@RequestParam(required = false) String limit) {
    int capped = Validation.clampLimit(limit, 50, Config.Limits.PAYMENTS_PAGE_SIZE);
    return Map.of("reviews", payments.listHeldForReview(capped));
  }

  /**
   * Leg 1 of the saga. Returns 201 with status PROCESSING - the money has left
   * the sender and is held in clearing, but the payment is not finished.
   */
  @PostMapping("/payments")
  public ResponseEntity<PaymentDto> initiate(HttpServletRequest request) {
    Map<String, Object> body = jsonBody.read(request);
    ValidatedTransfer transfer = Validation.parseTransfer(body);
    String note = Validation.parseNote(body.get("note"));
    var simulateMode = Validation.parseSimulateMode(body.get("simulate"), body.get("simulateFailure"));
    String suppliedKey = Validation.parseIdempotencyKey(request.getHeader("Idempotency-Key"));

    InitiatePaymentResult result =
        payments.initiatePayment(
            new InitiatePaymentInput(
                transfer.fromAccountId(),
                transfer.toAccountId(),
                transfer.amountCents(),
                note,
                simulateMode,
                suppliedKey));

    // Echoed so a client that sent no key can see the one derived for it.
    ResponseEntity.BodyBuilder response =
        ResponseEntity.status(result.replayed() ? HttpStatus.OK : HttpStatus.CREATED)
            .header("Idempotency-Key", result.idempotencyKey());
    if (result.replayed()) response.header("Idempotent-Replay", "true");
    return response.body(result.payment());
  }

  @GetMapping("/payments")
  public List<PaymentDto> list(
      @RequestParam(required = false) String accountId,
      @RequestParam(required = false) String limit) {
    String wanted = accountId == null || accountId.isEmpty() ? null : accountId;
    if (wanted != null && !Validation.isUuid(wanted)) throw HttpError.badRequest("INVALID_ACCOUNT_ID");
    return payments.listPayments(
        wanted, Validation.clampLimit(limit, 50, Config.Limits.PAYMENTS_PAGE_SIZE));
  }

  /** The payment plus the ledger legs it produced - its audit trail. */
  @GetMapping("/payments/{id}")
  public Map<String, Object> get(@PathVariable String id) {
    return payments.getPaymentWithLedger(Validation.requireUuid(id, "INVALID_PAYMENT_ID"));
  }

  /** Manual compensation. Only stranded money can be refunded. */
  @PostMapping("/payments/{id}/refund")
  public PaymentDto refund(@PathVariable String id) {
    return payments.refundPayment(Validation.requireUuid(id, "INVALID_PAYMENT_ID"));
  }

  /** Release held funds: the payment rejoins the ordinary settlement path. */
  @PostMapping("/payments/{id}/approve")
  public PaymentDto approve(@PathVariable String id) {
    return payments.approvePayment(Validation.requireUuid(id, "INVALID_PAYMENT_ID"));
  }

  /** Refuse held funds: compensated back to the sender, same as a stuck payment. */
  @PostMapping("/payments/{id}/reject")
  public PaymentDto reject(@PathVariable String id) {
    return payments.rejectPayment(Validation.requireUuid(id, "INVALID_PAYMENT_ID"));
  }
}
