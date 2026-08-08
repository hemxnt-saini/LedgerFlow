import Redis from 'ioredis';
import { config } from '../config';

/**
 * Redis use #1 of two (see the query service for #2): a short-lived cache of
 * idempotency-key -> response, so a retried POST /payments returns the
 * original result without touching Postgres at all.
 *
 * One connection for the process, created here so nothing else has to know
 * the URL or the client library.
 */
export const redis = new Redis(config.redisUrl);
