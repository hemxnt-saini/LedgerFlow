import Redis from 'ioredis';
import { config } from '../config';

/**
 * Redis use #2 of two (see the payment service for #1): this is the whole
 * database of the read side. There is no Postgres here - every value served
 * was projected from a Kafka event and can be deleted and rebuilt from the
 * log at any time.
 */
export const redis = new Redis(config.redisUrl);
