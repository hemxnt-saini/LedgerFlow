import { config } from '../config';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import type { AccountLimits } from '../domain/limits';
import { HttpError, notFound } from '../lib/http-error';
import { toAccountDto, type AccountDto } from '../models/account.model';
import * as accounts from '../repositories/account.repository';
import * as ledger from '../repositories/ledger.repository';
import * as outbox from '../repositories/outbox.repository';

/**
 * Opens a wallet.
 *
 * An opening balance is not money appearing from nowhere: it is issued by the
 * funding account, which goes negative by exactly this much. That is what
 * makes the ledger complete - every cent has a provenance, and the balances of
 * all accounts together still sum to zero, which is the invariant the
 * reconciliation control leans on.
 */
export async function createAccount(
  name: string,
  initialBalanceCents: number,
): Promise<AccountDto> {
  const row = await withTransaction(async (client) => {
    const account = await accounts.insert(client, name, initialBalanceCents);

    if (initialBalanceCents > 0) {
      const locked = await accounts.lockMany(client, [config.systemAccounts.fundingId]);
      const funding = locked.get(config.systemAccounts.fundingId);
      if (!funding) throw new HttpError(500, 'FUNDING_ACCOUNT_MISSING');

      await accounts.updateBalance(
        client,
        funding.id,
        funding.balanceCents - initialBalanceCents,
      );
      await ledger.postJournal(client, null, 'FUNDING', [
        { accountId: funding.id, direction: 'DEBIT', amountCents: initialBalanceCents },
        { accountId: account.id, direction: 'CREDIT', amountCents: initialBalanceCents },
      ]);
    }

    await outbox.enqueue(client, 'account.created', {
      accountId: account.id,
      name: account.name,
      balanceCents: account.balance_cents,
      occurredAt: account.created_at.toISOString(),
    });
    return account;
  });

  return toAccountDto(row);
}

/**
 * The system accounts are plumbing, not people - hidden from the wallet's
 * friends list, visible to the developer dashboard.
 */
export async function listAccounts(includeSystem: boolean): Promise<AccountDto[]> {
  const rows = await accounts.findAll(pool, includeSystem);
  return rows.map(toAccountDto);
}

export async function getAccount(id: string): Promise<AccountDto> {
  const row = await accounts.findById(pool, id);
  if (!row) throw notFound('ACCOUNT_NOT_FOUND');
  return toAccountDto(row);
}

export interface AccountLimitsView {
  accountId: string;
  limits: AccountLimits;
  usage: {
    todayCents: number;
    recentCount: number;
    windowSeconds: number;
  };
  /** Headroom left against the daily cap, so a client can warn before sending. */
  remainingTodayCents: number;
}

/**
 * An account's spending controls and how much of them it has used.
 *
 * Read outside a transaction and without a lock: this is for showing someone
 * their headroom, not for deciding anything. The number that matters is
 * recomputed under the sender's row lock at authorise time, which is the only
 * place it can be trusted.
 */
export async function getLimits(id: string): Promise<AccountLimitsView> {
  const limits = await accounts.findLimits(pool, id);
  if (!limits) throw notFound('ACCOUNT_NOT_FOUND');

  const { velocityWindowSeconds } = config.controls;
  const usage = await accounts.spendSoFar(pool, id, velocityWindowSeconds);

  return {
    accountId: id,
    limits,
    usage: { ...usage, windowSeconds: velocityWindowSeconds },
    remainingTodayCents: Math.max(0, limits.dailyLimitCents - usage.todayCents),
  };
}

/** System accounts are plumbing and have no spending controls to set. */
export async function setLimits(
  id: string,
  limits: AccountLimits,
): Promise<AccountLimitsView> {
  const updated = await withTransaction((client) =>
    accounts.updateLimits(client, id, limits),
  );
  if (!updated) throw notFound('ACCOUNT_NOT_FOUND');
  return getLimits(id);
}
