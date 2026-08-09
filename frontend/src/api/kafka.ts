import { READ_URL } from '../lib/config';
import type { KafkaOverview } from '../types/api';
import { request } from './client';

export const getOverview = () => request<KafkaOverview>(`${READ_URL}/kafka/overview`);

export const pauseConsumer = () =>
  request<{ paused: boolean }>(`${READ_URL}/kafka/consumer/pause`, { method: 'POST' });

export const resumeConsumer = () =>
  request<{ paused: boolean }>(`${READ_URL}/kafka/consumer/resume`, { method: 'POST' });

/** Deletes the whole read model and rewinds every partition to offset zero. */
export const rebuildReadModel = () =>
  request<{ cleared: number; rewoundPartitions: number }>(
    `${READ_URL}/kafka/consumer/rebuild`,
    { method: 'POST' },
  );
