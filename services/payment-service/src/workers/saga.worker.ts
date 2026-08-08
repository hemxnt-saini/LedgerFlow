import type { PoolClient } from 'pg';
import { config } from '../config';
import { withTransaction } from '../db/transaction';
import type { PaymentStatus } from '../domain/payment';
import { log, newCorrelationId, withContext } from '../lib/logger';
import { startPoller, type Poller } from '../lib/poller';
import type { PaymentRow } from '../models/payment.model';
import * as payments from '../repositories/payment.repository';
import { compensate, settle } from '../services/saga.service';

/** Claims a batch of due payments in one status and runs `step` on each. */
async function drain(
  status: PaymentStatus,
  step: (client: PoolClient, row: PaymentRow) => Promise<PaymentStatus>,
): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await payments.claimDue(client, status, config.saga.batchSize);

    for (const row of rows) {
      // Background work adopts the correlation id the payment was created
      // with, so a settlement seconds or hours later is still traceable to the
      // request that started it - even though no HTTP request is in flight.
      await withContext(
        { correlationId: row.correlation_id ?? newCorrelationId(), paymentId: row.id },
        async () => {
          const next = await step(client, row);
          log.info('saga transition', {
            from: row.status,
            to: next,
            attempts: row.attempts,
          });
        },
      );
    }
  });
}

/** Leg 2 runner: PROCESSING -> COMPLETED, or -> AWAITING_REFUND. */
export function startSettlementWorker(): Poller {
  return startPoller('settle', config.saga.pollMs, () => drain('PROCESSING', settle));
}

/**
 * Automatic compensation: AWAITING_REFUND -> REFUNDED. A stuck payment repays
 * itself without anyone pressing a button; the manual endpoint just skips the
 * wait.
 */
export function startCompensationWorker(): Poller {
  return startPoller('compensate', config.saga.pollMs, () =>
    drain('AWAITING_REFUND', compensate),
  );
}
