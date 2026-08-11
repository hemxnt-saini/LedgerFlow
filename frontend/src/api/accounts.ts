import { WRITE_URL } from '../lib/config';
import type { Account, AccountLimits, AccountLimitsView } from '../types/api';
import { jsonHeaders, request } from './client';

export const listAccounts = (includeSystem = false) =>
  request<Account[]>(`${WRITE_URL}/accounts${includeSystem ? '?includeSystem=true' : ''}`);

export const createAccount = (name: string, initialBalanceCents: number) =>
  request<Account>(`${WRITE_URL}/accounts`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name, initialBalanceCents }),
  });

/**
 * Spending controls and how much of today's allowance is used.
 *
 * Advisory only: this is for showing headroom before someone sends. The
 * number that decides anything is recomputed under the sender's row lock
 * inside the authorise transaction.
 */
export const getLimits = (accountId: string) =>
  request<AccountLimitsView>(`${WRITE_URL}/accounts/${accountId}/limits`);

export const setLimits = (accountId: string, limits: AccountLimits) =>
  request<AccountLimitsView>(`${WRITE_URL}/accounts/${accountId}/limits`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(limits),
  });
