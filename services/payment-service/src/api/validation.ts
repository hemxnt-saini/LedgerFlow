import { config } from '../config';
import type { AccountLimits } from '../domain/limits';
import { isValidAmount, type SimulateMode } from '../domain/payment';
import { badRequest } from '../lib/http-error';

/**
 * The trust boundary. Nothing past this file assumes anything about the shape
 * of a request - if a value got here, it is the right type and within range.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value);

export function requireUuid(value: unknown, code: string): string {
  if (!isUuid(value)) throw badRequest(code);
  return value;
}

/**
 * Clamped both ways: a negative limit would become a negative range index,
 * which some stores read as "from the end" and quietly return the wrong slice.
 */
export const clampLimit = (raw: unknown, fallback: number, max: number): number =>
  Math.min(Math.max(Number(raw ?? fallback) || fallback, 1), max);

export function parseAccountName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest('NAME_REQUIRED');
  const name = value.trim();
  if (name.length > config.limits.nameLength) throw badRequest('NAME_TOO_LONG');
  return name;
}

export function parseOpeningBalance(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw badRequest('INVALID_INITIAL_BALANCE');
  }
  return value as number;
}

/** A limit is a non-negative whole number of cents; zero means "blocked". */
function parseCap(value: unknown, code: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw badRequest(code);
  }
  return value as number;
}

export function parseLimits(body: Record<string, unknown>): AccountLimits {
  return {
    maxPaymentCents: parseCap(
      body.maxPaymentCents,
      'INVALID_MAX_PAYMENT',
      config.limits.maxLimitCents,
    ),
    dailyLimitCents: parseCap(
      body.dailyLimitCents,
      'INVALID_DAILY_LIMIT',
      config.limits.maxLimitCents,
    ),
    velocityMax: parseCap(body.velocityMax, 'INVALID_VELOCITY_MAX', 10_000),
  };
}

export function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest('INVALID_NOTE');
  if (value.length > config.limits.noteLength) throw badRequest('NOTE_TOO_LONG');
  return value.trim() || null;
}

/**
 * How the settle leg should be made to fail, for demonstrating the saga.
 * `simulate` is the current field; the older boolean `simulateFailure: true`
 * is still accepted and means "permanent".
 */
export function parseSimulateMode(
  simulate: unknown,
  simulateFailure: unknown,
): SimulateMode {
  let mode: SimulateMode = 'NONE';

  if (simulateFailure !== undefined) {
    if (typeof simulateFailure !== 'boolean') throw badRequest('INVALID_SIMULATE_FAILURE');
    if (simulateFailure) mode = 'PERMANENT';
  }

  if (simulate !== undefined) {
    const wanted = String(simulate).toUpperCase();
    if (!['NONE', 'TRANSIENT', 'PERMANENT'].includes(wanted)) {
      throw badRequest('INVALID_SIMULATE_MODE');
    }
    mode = wanted as SimulateMode;
  }

  return mode;
}

export function parseIdempotencyKey(header: string | undefined): string | null {
  const key = header?.trim() || null;
  if (key && key.length > config.limits.idempotencyKeyLength) {
    throw badRequest('IDEMPOTENCY_KEY_TOO_LONG');
  }
  return key;
}

export interface ValidatedTransfer {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
}

export function parseTransfer(body: Record<string, unknown>): ValidatedTransfer {
  const fromAccountId = String(body.fromAccountId);
  const toAccountId = String(body.toAccountId);

  if (!isUuid(fromAccountId) || !isUuid(toAccountId)) throw badRequest('INVALID_ACCOUNT_ID');
  if (!isValidAmount(body.amountCents)) throw badRequest('INVALID_AMOUNT');
  if (fromAccountId === toAccountId) throw badRequest('SAME_ACCOUNT');

  // The clearing and funding accounts are plumbing. Letting a client move
  // money in or out of them directly would put the ledger's invariants at the
  // mercy of the API.
  const systemIds: string[] = [
    config.systemAccounts.clearingId,
    config.systemAccounts.fundingId,
  ];
  if (systemIds.includes(fromAccountId) || systemIds.includes(toAccountId)) {
    throw badRequest('SYSTEM_ACCOUNT_NOT_PAYABLE');
  }

  return { fromAccountId, toAccountId, amountCents: body.amountCents };
}
