/**
 * The two backends, and the split is the whole point:
 *   WRITE (:4000) commands - send a payment, refund one. Owns Postgres.
 *   READ  (:4001) queries  - balances, history, stats, and the live SSE feed.
 *                            Owns nothing but a Redis projection of Kafka.
 *
 * Derived from the browser's own hostname so the same bundle works on
 * localhost and on a LAN address without a rebuild.
 */
const host = typeof window === 'undefined' ? 'localhost' : window.location.hostname;

export const WRITE_URL = import.meta.env.VITE_WRITE_URL ?? `http://${host}:4000`;
export const READ_URL = import.meta.env.VITE_READ_URL ?? `http://${host}:4001`;

/** Fixed id, so the pipeline monitor can show money in flight without a lookup. */
export const CLEARING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

export const REQUEST_TIMEOUT_MS = 8_000;
