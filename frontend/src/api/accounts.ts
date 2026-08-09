import { WRITE_URL } from '../lib/config';
import type { Account } from '../types/api';
import { jsonHeaders, request } from './client';

export const listAccounts = (includeSystem = false) =>
  request<Account[]>(`${WRITE_URL}/accounts${includeSystem ? '?includeSystem=true' : ''}`);

export const createAccount = (name: string, initialBalanceCents: number) =>
  request<Account>(`${WRITE_URL}/accounts`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name, initialBalanceCents }),
  });
