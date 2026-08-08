/**
 * Every environment variable this service reads, in one place.
 *
 * Nothing else in the codebase touches `process.env`, so the full set of knobs
 * is discoverable here rather than scattered across a dozen modules.
 */

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  serviceName: process.env.SERVICE_NAME ?? 'ledger-query-service',
  port: num(process.env.PORT, 4001),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',

  kafka: {
    clientId: 'ledger-query-service',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
    topic: process.env.KAFKA_TOPIC ?? 'payment-events',
    dlqTopic: process.env.KAFKA_DLQ_TOPIC ?? 'payment-events-dlq',
    /**
     * Order is guaranteed per key, not across the topic. Safe here because
     * every balance mutation in the projection is a commutative delta.
     */
    partitions: num(process.env.KAFKA_PARTITIONS, 3),
    groupId: process.env.KAFKA_GROUP_ID ?? 'ledger-query-service',
    dlqGroupId: process.env.KAFKA_DLQ_GROUP_ID ?? 'ledger-query-service-dlq',
  },

  /** How much history the browsable copies of each feed keep. */
  retention: {
    pipelineTraces: 200,
    dlqEntries: 200,
  },

  limits: {
    transactionsPageSize: 100,
    feedPageSize: 200,
    bulkBalanceIds: 100,
  },

  /** Proxies and browsers drop an idle SSE stream without a heartbeat. */
  streamKeepAliveMs: 20_000,
} as const;

export type Config = typeof config;
