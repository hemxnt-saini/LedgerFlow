import { WRITE_URL } from '../lib/config';
import type { AccountStatement, JournalEntry, TrialBalance } from '../types/api';
import { request } from './client';

/**
 * Ledger reads come from the write side, not the read model - deliberately.
 *
 * The Redis projection is a convenience built for speed; the journal in
 * Postgres is the record. A page whose whole purpose is to prove the books
 * are correct must read the books, not a cache of them.
 */

export const getTrialBalance = () => request<TrialBalance>(`${WRITE_URL}/ledger/trial-balance`);

export const getJournal = (limit = 50, accountId?: string | null) =>
  request<{ entries: JournalEntry[] }>(
    `${WRITE_URL}/ledger/journal?limit=${limit}${accountId ? `&accountId=${accountId}` : ''}`,
  );

export const getStatement = (accountId: string, limit = 100) =>
  request<AccountStatement>(`${WRITE_URL}/ledger/accounts/${accountId}?limit=${limit}`);
