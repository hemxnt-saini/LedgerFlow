import { READ_URL } from '../lib/config';
import type { DeadLetter } from '../types/api';
import { request } from './client';

export const listDeadLetters = (limit = 10) =>
  request<{ topic: string; pending: number; entries: DeadLetter[] }>(
    `${READ_URL}/dlq?limit=${limit}`,
  );

/** Safe to repeat: the read model claims each event id before applying it. */
export const replayDeadLetter = (dlqId: string) =>
  request<DeadLetter>(`${READ_URL}/dlq/${dlqId}/replay`, { method: 'POST' });

/** Demo only: writes an unparseable message so it can be watched being parked. */
export const poisonTopic = () =>
  request<{ topic: string; payload: string }>(`${READ_URL}/dlq/demo/poison`, {
    method: 'POST',
  });
