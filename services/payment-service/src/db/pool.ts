import { Pool, types, type PoolClient } from 'pg';
import { config } from '../config';

// pg returns BIGINT as a string to avoid precision loss. Cent amounts are far
// below Number.MAX_SAFE_INTEGER, so read them as numbers and keep the maths
// in one representation.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export const pool = new Pool({ connectionString: config.databaseUrl });

/**
 * Anything that can run a query - the pool itself, or a client bound to an
 * open transaction. Repositories take one of these rather than reaching for
 * the pool directly, so the same function works inside and outside a
 * transaction and the caller decides which.
 */
export type Queryable = Pick<PoolClient, 'query'>;
