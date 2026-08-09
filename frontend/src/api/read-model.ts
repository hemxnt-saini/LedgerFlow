import { READ_URL } from '../lib/config';
import type { ActivityEntry, PipelineTrace, ProjectedPayment, Stats } from '../types/api';
import { request } from './client';

export const getBalances = (ids: string[]) =>
  request<{ balances: Record<string, number> }>(
    `${READ_URL}/balances?ids=${ids.join(',')}`,
  );

export const getTransactions = (accountId: string, limit = 100) =>
  request<{ transactions: ProjectedPayment[] }>(
    `${READ_URL}/accounts/${accountId}/transactions?limit=${limit}`,
  );

export const getStats = (accountId: string) =>
  request<Stats>(`${READ_URL}/accounts/${accountId}/stats`);

export const getActivity = (limit = 40) =>
  request<{ activity: ActivityEntry[] }>(`${READ_URL}/activity?limit=${limit}`);

export const getPipelineTraces = (limit = 200) =>
  request<{ traces: PipelineTrace[] }>(`${READ_URL}/pipeline?limit=${limit}`);
