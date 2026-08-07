import express, { type NextFunction, type Request, type Response } from 'express';
import Redis from 'ioredis';
import {
  MAX_SETTLE_ATTEMPTS,
  canRefund,
  deriveIdempotencyKey,
  isDerivedKey,
  isValidAmount,
  moveFunds,
  requestFingerprint,
  type SimulateMode,
} from './domain';
import {
  CLEARING_ACCOUNT_ID,
  FUNDING_ACCOUNT_ID,
  enqueueEvent,
  initSchema,
  pool,
  withTransaction,
} from './db';
import { startOutboxPublisher } from './outbox';
import { currentCorrelationId, log, newCorrelationId, withContext } from './logger';
import { runReconciliation, startReconciler } from './reconciler';
import {
  SETTLE_DELAY_MS,
  compensate,
  postJournal,
  lockAccounts,
  setBalance,
  startCompensationWorker,
  startSettlementWorker,
  type PaymentRow,
} from './saga';

const PORT = Number(process.env.PORT ?? 4000);
// A client-supplied key is a promise about a specific payment, so it is
// remembered for a day. A key we derived ourselves is only a double-submit
// guard, so it expires in a minute - otherwise a legitimate repeat payment of
// the same amount would be swallowed.
const IDEMPOTENCY_TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL ?? 86_400);
const DERIVED_TTL_SECONDS = Number(process.env.DERIVED_IDEMPOTENCY_TTL ?? 60);
const MAX_NAME_LENGTH = 200;
const MAX_NOTE_LENGTH = 140;
const MAX_KEY_LENGTH = 255;

// Redis use #1 (see the query service for #2): a short-lived cache of
// idempotency-key -> response, so a retried POST /payments returns the
// original result without touching Postgres at all.
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const app = express();
app.use(express.json());

/**
 * Every request runs inside a correlation id - taken from the caller if they
 * sent one, minted here if not - and it is echoed back so a client can quote
 * it. Everything logged downstream, including work that happens seconds later
 * in a background worker, carries the same id.
 */
app.use((req, res, next) => {
  const correlationId = req.header('X-Correlation-Id')?.trim() || newCorrelationId();
  res.set('X-Correlation-Id', correlationId);
  const startedAt = Date.now();
  withContext({ correlationId }, () => {
    res.on('finish', () => {
      const fields = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      };
      if (res.statusCode >= 500) log.error('request failed', fields);
      else log.info('request', fields);
    });
    next();
  });
});

// The frontend is served from a different origin (nginx on :8080).
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // Without this, fetch() cannot read these - CORS only exposes a handful of
  // simple response headers by default.
  res.set('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-Correlation-Id');
  res.set('Access-Control-Expose-Headers', 'Idempotent-Replay, Idempotency-Key, X-Correlation-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toPaymentDto = (row: PaymentRow) => ({
  id: row.id,
  fromAccountId: row.from_account_id,
  toAccountId: row.to_account_id,
  amountCents: row.amount_cents,
  note: row.note,
  status: row.status,
  failureReason: row.failure_reason,
  simulateMode: row.simulate_mode,
  attempts: row.attempts,
  maxAttempts: MAX_SETTLE_ATTEMPTS,
  nextAttemptAt: row.next_attempt_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toAccountDto = (row: {
  id: string;
  name: string;
  balance_cents: number;
  is_system: boolean;
  created_at: Date;
}) => ({
  id: row.id,
  name: row.name,
  balanceCents: row.balance_cents,
  isSystem: row.is_system,
  createdAt: row.created_at,
});

const idempotencyCacheKey = (key: string) => `idempotency:${key}`;

/** What gets cached in Redis under an idempotency key. */
interface CachedResult {
  fingerprint: string;
  response: ReturnType<typeof toPaymentDto>;
}

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'payment-service' }),
);

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

app.post(
  '/accounts',
  asyncRoute(async (req, res) => {
    const { name, initialBalanceCents } = req.body ?? {};
    if (typeof name !== 'string' || name.trim() === '') {
      throw new HttpError(400, 'NAME_REQUIRED');
    }
    if (name.trim().length > MAX_NAME_LENGTH) throw new HttpError(400, 'NAME_TOO_LONG');
    if (
      !Number.isSafeInteger(initialBalanceCents) ||
      (initialBalanceCents as number) < 0
    ) {
      throw new HttpError(400, 'INVALID_INITIAL_BALANCE');
    }

    const account = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO accounts (name, balance_cents) VALUES ($1, $2)
         RETURNING id, name, balance_cents, is_system, created_at`,
        [name.trim(), initialBalanceCents],
      );
      const row = rows[0];

      // An opening balance is not money from nowhere. It is issued by the
      // funding account, which goes negative by exactly this much - so the
      // ledger can explain every cent in the system and all balances together
      // still sum to zero.
      if (initialBalanceCents > 0) {
        const funding = await lockAccounts(client, [FUNDING_ACCOUNT_ID]);
        const source = funding.get(FUNDING_ACCOUNT_ID);
        if (!source) throw new HttpError(500, 'FUNDING_ACCOUNT_MISSING');
        await setBalance(client, source.id, source.balanceCents - initialBalanceCents);
        await postJournal(client, null, 'FUNDING', [
          { accountId: source.id, direction: 'DEBIT', amountCents: initialBalanceCents },
          { accountId: row.id, direction: 'CREDIT', amountCents: initialBalanceCents },
        ]);
      }

      await enqueueEvent(client, 'account.created', {
        accountId: row.id,
        name: row.name,
        balanceCents: row.balance_cents,
        occurredAt: row.created_at.toISOString(),
      });
      return row;
    });

    res.status(201).json(toAccountDto(account));
  }),
);

app.get(
  '/accounts',
  asyncRoute(async (req, res) => {
    // The clearing account is plumbing, not a person - hidden from the wallet's
    // friends list, visible to the developer dashboard.
    const includeSystem = req.query.includeSystem === 'true';
    const { rows } = await pool.query(
      `SELECT id, name, balance_cents, is_system, created_at FROM accounts
        WHERE $1::boolean OR NOT is_system
        ORDER BY is_system, created_at`,
      [includeSystem],
    );
    res.json(rows.map(toAccountDto));
  }),
);

app.get(
  '/accounts/:id',
  asyncRoute(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new HttpError(400, 'INVALID_ACCOUNT_ID');
    const { rows } = await pool.query(
      'SELECT id, name, balance_cents, is_system, created_at FROM accounts WHERE id = $1',
      [req.params.id],
    );
    if (!rows[0]) throw new HttpError(404, 'ACCOUNT_NOT_FOUND');
    res.json(toAccountDto(rows[0]));
  }),
);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Leg 1 of the saga: take the money off the sender and hold it in clearing.
 *
 * This returns as soon as the funds are held - the payment is PROCESSING, not
 * finished. The settlement worker moves it on to the receiver a moment later.
 */
app.post(
  '/payments',
  asyncRoute(async (req, res) => {
    const { fromAccountId, toAccountId, amountCents, note, simulateFailure, simulate } =
      req.body ?? {};
    const suppliedKey = req.header('Idempotency-Key')?.trim() || null;

    if (!UUID_RE.test(String(fromAccountId)) || !UUID_RE.test(String(toAccountId))) {
      throw new HttpError(400, 'INVALID_ACCOUNT_ID');
    }
    if (!isValidAmount(amountCents)) throw new HttpError(400, 'INVALID_AMOUNT');
    if (fromAccountId === toAccountId) throw new HttpError(400, 'SAME_ACCOUNT');
    const systemIds = [CLEARING_ACCOUNT_ID, FUNDING_ACCOUNT_ID];
    if (systemIds.includes(fromAccountId) || systemIds.includes(toAccountId)) {
      throw new HttpError(400, 'SYSTEM_ACCOUNT_NOT_PAYABLE');
    }
    if (note !== undefined && note !== null && typeof note !== 'string') {
      throw new HttpError(400, 'INVALID_NOTE');
    }
    if (typeof note === 'string' && note.length > MAX_NOTE_LENGTH) {
      throw new HttpError(400, 'NOTE_TOO_LONG');
    }
    // `simulate` picks how the settle leg is made to fail. The older boolean
    // `simulateFailure: true` still means "permanent".
    let simulateMode: SimulateMode = 'NONE';
    if (simulateFailure !== undefined) {
      if (typeof simulateFailure !== 'boolean') {
        throw new HttpError(400, 'INVALID_SIMULATE_FAILURE');
      }
      if (simulateFailure) simulateMode = 'PERMANENT';
    }
    if (simulate !== undefined) {
      const wanted = String(simulate).toUpperCase();
      if (!['NONE', 'TRANSIENT', 'PERMANENT'].includes(wanted)) {
        throw new HttpError(400, 'INVALID_SIMULATE_MODE');
      }
      simulateMode = wanted as SimulateMode;
    }
    if (suppliedKey && suppliedKey.length > MAX_KEY_LENGTH) {
      throw new HttpError(400, 'IDEMPOTENCY_KEY_TOO_LONG');
    }

    const cleanNote = typeof note === 'string' ? note.trim() || null : null;

    // Every payment gets an idempotency key whether the caller sent one or
    // not. No key at all would mean no protection at all, and a randomly
    // generated one would differ on every retry and protect nobody - so an
    // absent key is derived from the request content instead.
    const idempotencyKey =
      suppliedKey ??
      deriveIdempotencyKey(fromAccountId, toAccountId, amountCents, cleanNote ?? '');
    const derived = isDerivedKey(idempotencyKey);
    const fingerprint = requestFingerprint(
      fromAccountId,
      toAccountId,
      amountCents,
      cleanNote ?? '',
    );
    res.set('Idempotency-Key', idempotencyKey);

    // First line of defence: the Redis cache. A replayed request never
    // reaches Postgres.
    const cached = await redis.get(idempotencyCacheKey(idempotencyKey));
    if (cached) {
      const entry: CachedResult = JSON.parse(cached);
      // Same key, different request: the caller has a bug. Returning the
      // first payment would quietly answer a question they did not ask.
      if (entry.fingerprint !== fingerprint) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
      }
      return res.status(200).set('Idempotent-Replay', 'true').json(entry.response);
    }

    let payment: ReturnType<typeof toPaymentDto>;
    try {
      payment = await withTransaction(async (client) => {
        const accounts = await lockAccounts(client, [
          fromAccountId,
          CLEARING_ACCOUNT_ID,
          toAccountId,
        ]);
        const sender = accounts.get(fromAccountId);
        const clearing = accounts.get(CLEARING_ACCOUNT_ID);
        const receiver = accounts.get(toAccountId);
        if (!sender || !receiver) throw new HttpError(404, 'ACCOUNT_NOT_FOUND');
        if (!clearing) throw new HttpError(500, 'CLEARING_ACCOUNT_MISSING');

        const authorise = moveFunds(sender, clearing, amountCents);

        // Balances, the payment row, the ledger entries and the outbox event
        // all commit together - or none of them do.
        const { rows } = await client.query<PaymentRow>(
          `INSERT INTO payments
             (from_account_id, to_account_id, amount_cents, note, status,
              failure_reason, idempotency_key, simulate_mode, next_attempt_at,
              correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   now() + ($9::int * interval '1 millisecond'), $10)
           RETURNING *`,
          [
            sender.id,
            receiver.id,
            amountCents,
            cleanNote,
            authorise.ok ? 'PROCESSING' : 'FAILED',
            authorise.ok ? null : authorise.failureReason,
            // Only a client-supplied key is persisted. A derived key is a
            // content hash, and the UNIQUE constraint would then permanently
            // block the same payer sending the same payee the same amount
            // ever again.
            suppliedKey,
            simulateMode,
            // Leg 2 is due after a deliberate pause, so the half-finished
            // state is long enough to see.
            SETTLE_DELAY_MS,
            currentCorrelationId() ?? null,
          ],
        );
        const row = rows[0];

        const body = {
          paymentId: row.id,
          fromAccountId: row.from_account_id,
          toAccountId: row.to_account_id,
          amountCents: row.amount_cents,
          note: row.note,
          occurredAt: row.created_at.toISOString(),
        };

        if (!authorise.ok) {
          await enqueueEvent(client, 'payment.failed', {
            ...body,
            failureReason: authorise.failureReason,
          });
          return toPaymentDto(row);
        }

        await setBalance(client, sender.id, authorise.fromBalanceCents);
        await setBalance(client, clearing.id, authorise.toBalanceCents);
        await postJournal(client, row.id, 'AUTHORISE', authorise.entries);
        await enqueueEvent(client, 'payment.initiated', body);
        return toPaymentDto(row);
      });
    } catch (err) {
      // Second line of defence: the UNIQUE constraint on idempotency_key.
      // Catches two identical requests racing past the Redis check together -
      // the loser's INSERT blocks on the index until the winner commits, then
      // raises 23505, so the row below is guaranteed to be visible.
      if (suppliedKey && (err as { code?: string }).code === '23505') {
        const { rows } = await pool.query<PaymentRow>(
          'SELECT * FROM payments WHERE idempotency_key = $1',
          [suppliedKey],
        );
        if (rows[0]) {
          return res
            .status(200)
            .set('Idempotent-Replay', 'true')
            .json(toPaymentDto(rows[0]));
        }
      }
      throw err;
    }

    const entry: CachedResult = { fingerprint, response: payment };
    await redis.set(
      idempotencyCacheKey(idempotencyKey),
      JSON.stringify(entry),
      'EX',
      derived ? DERIVED_TTL_SECONDS : IDEMPOTENCY_TTL_SECONDS,
    );
    res.status(201).json(payment);
  }),
);

app.get(
  '/payments',
  asyncRoute(async (req, res) => {
    const accountId = req.query.accountId ? String(req.query.accountId) : null;
    if (accountId && !UUID_RE.test(accountId)) {
      throw new HttpError(400, 'INVALID_ACCOUNT_ID');
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const { rows } = await pool.query<PaymentRow>(
      `SELECT * FROM payments
        WHERE $1::uuid IS NULL OR from_account_id = $1 OR to_account_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [accountId, limit],
    );
    res.json(rows.map(toPaymentDto));
  }),
);

/**
 * A payment plus the ledger legs it produced - the audit trail behind the
 * status. A completed payment shows AUTHORISE then SETTLE; a refunded one
 * shows AUTHORISE then COMPENSATE.
 */
app.get(
  '/payments/:id',
  asyncRoute(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new HttpError(400, 'INVALID_PAYMENT_ID');
    const { rows } = await pool.query<PaymentRow>(
      'SELECT * FROM payments WHERE id = $1',
      [req.params.id],
    );
    if (!rows[0]) throw new HttpError(404, 'PAYMENT_NOT_FOUND');

    const ledger = await pool.query(
      `SELECT l.leg, l.direction, l.amount_cents, l.account_id, a.name, l.created_at
         FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
        WHERE l.payment_id = $1 ORDER BY l.id`,
      [req.params.id],
    );

    res.json({
      ...toPaymentDto(rows[0]),
      ledger: ledger.rows.map((entry) => ({
        leg: entry.leg,
        direction: entry.direction,
        amountCents: entry.amount_cents,
        accountId: entry.account_id,
        accountName: entry.name,
        createdAt: entry.created_at,
      })),
    });
  }),
);

/**
 * Manual compensation. The worker does this automatically after a few seconds;
 * this endpoint just skips the wait. Only stranded money can be refunded - a
 * completed payment arrived, so there is nothing to recover.
 */
app.post(
  '/payments/:id/refund',
  asyncRoute(async (req, res) => {
    const paymentId = req.params.id;
    if (!UUID_RE.test(paymentId)) throw new HttpError(400, 'INVALID_PAYMENT_ID');

    const payment = await withTransaction(async (client) => {
      // Lock the payment row first so two concurrent refunds cannot both see
      // AWAITING_REFUND.
      const { rows } = await client.query<PaymentRow>(
        'SELECT * FROM payments WHERE id = $1 FOR UPDATE',
        [paymentId],
      );
      const original = rows[0];
      if (!original) throw new HttpError(404, 'PAYMENT_NOT_FOUND');
      if (!canRefund(original.status)) {
        throw new HttpError(409, `NOT_REFUNDABLE_FROM_${original.status}`);
      }

      await compensate(client, original);
      const updated = await client.query<PaymentRow>(
        'SELECT * FROM payments WHERE id = $1',
        [paymentId],
      );
      return toPaymentDto(updated.rows[0]);
    });

    res.json(payment);
  }),
);

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

const toRunDto = (row: {
  id: number;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  checked_accounts: number;
  drift_cents: number;
  findings: unknown;
  duration_ms: number | null;
}) => ({
  id: row.id,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  status: row.status,
  checkedAccounts: row.checked_accounts,
  driftCents: row.drift_cents,
  findings: row.findings,
  durationMs: row.duration_ms,
});

/** The latest verdict plus recent history, so drift has a first sighting. */
app.get(
  '/reconciliation',
  asyncRoute(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
    const { rows } = await pool.query(
      'SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT $1',
      [limit],
    );
    res.json({
      latest: rows[0] ? toRunDto(rows[0]) : null,
      history: rows.map(toRunDto),
    });
  }),
);

/** Run the control now rather than waiting for the next scheduled pass. */
app.post(
  '/reconciliation/run',
  asyncRoute(async (_req, res) => {
    res.json(await runReconciliation(redis));
  }),
);

// A JSON API should answer an unknown path in JSON, not Express' HTML page.
app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code });
  }
  // express.json() rejects malformed bodies with status 400 already set;
  // without this they would surface as a misleading 500.
  const status = (err as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return res.status(status).json({ error: 'INVALID_REQUEST_BODY' });
  }
  log.error('unhandled error', { err });
  res.status(500).json({ error: 'INTERNAL_ERROR', correlationId: currentCorrelationId() });
});

async function main() {
  await initSchema();
  const workers = [
    startOutboxPublisher(),
    startSettlementWorker(),
    startCompensationWorker(),
    startReconciler(redis),
  ];
  const server = app.listen(PORT, () => log.info('listening', { port: PORT }));

  const shutdown = async () => {
    server.close();
    await Promise.all(workers.map((worker) => worker.stop()));
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error('failed to start', { err });
  process.exit(1);
});
