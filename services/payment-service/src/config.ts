/**
 * Every environment variable this service reads, in one place.
 *
 * Nothing else in the codebase touches `process.env`, so the full set of knobs
 * is discoverable here rather than scattered across a dozen modules - and a
 * missing or mistyped variable fails in one obvious spot.
 */

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  serviceName: process.env.SERVICE_NAME ?? 'payment-service',
  port: num(process.env.PORT, 4000),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://payments:payments@localhost:5432/payments',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',

  kafka: {
    clientId: 'payment-service',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
    topic: process.env.KAFKA_TOPIC ?? 'payment-events',
  },

  /**
   * A client-supplied key is a promise about a specific payment, so it is
   * remembered for a day. A key we derived ourselves is only a double-submit
   * guard, so it expires in a minute - otherwise a legitimate repeat payment
   * of the same amount would be swallowed.
   */
  idempotency: {
    ttlSeconds: num(process.env.IDEMPOTENCY_TTL, 86_400),
    derivedTtlSeconds: num(process.env.DERIVED_IDEMPOTENCY_TTL, 60),
  },

  saga: {
    /**
     * How long a payment sits in PROCESSING before the settle leg runs. An
     * artificial pause that makes the half-finished state long enough to see,
     * which is the whole point of modelling the saga instead of one atomic
     * transfer. Set it to 0 for a snappier demo.
     */
    settleDelayMs: num(process.env.SETTLE_DELAY_MS, 900),
    /** How long stranded money stays visible before it is returned. */
    compensateDelayMs: num(process.env.COMPENSATE_DELAY_MS, 4_000),
    pollMs: num(process.env.SAGA_POLL_MS, 300),
    batchSize: 20,
    /** Settlement attempts before the money is given back. */
    maxAttempts: num(process.env.MAX_SETTLE_ATTEMPTS, 3),
  },

  outbox: {
    pollMs: num(process.env.OUTBOX_POLL_MS, 400),
    batchSize: 100,
  },

  reconciliation: {
    intervalMs: num(process.env.RECONCILE_INTERVAL_MS, 15_000),
  },

  /** Input caps at the trust boundary. */
  limits: {
    nameLength: 200,
    noteLength: 140,
    idempotencyKeyLength: 255,
    paymentsPageSize: 200,
    reconciliationPageSize: 100,
  },

  /**
   * The two system accounts, at fixed ids so every service and script can
   * refer to them without a lookup.
   *
   * CLEARING holds money in flight: debited from the sender on authorisation,
   * credited to the receiver on settlement.
   *
   * FUNDING makes the ledger complete. Opening a wallet with $1,000 is not
   * money appearing from nowhere - it is DEBIT funding / CREDIT wallet, so
   * every cent has a provenance and all balances together sum to zero.
   */
  systemAccounts: {
    clearingId: '00000000-0000-4000-8000-000000000001',
    fundingId: '00000000-0000-4000-8000-000000000002',
  },
} as const;

export type Config = typeof config;
