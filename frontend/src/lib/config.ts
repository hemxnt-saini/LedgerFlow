/**
 * The two backends, and the split is the whole point:
 *   WRITE (:4000) commands - send a payment, refund one. Owns Postgres.
 *   READ  (:4001) queries  - balances, history, stats, and the live SSE feed.
 *                            Owns nothing but a Redis projection of Kafka.
 *
 * Two shapes, chosen at build time.
 *
 * Locally the services are port-mapped, so the default is derived from the
 * browser's own hostname - the same bundle then works on localhost and on a
 * LAN address without a rebuild.
 *
 * Deployed behind one HTTPS domain, those defaults are wrong twice over: the
 * ports are not published, and a page served over HTTPS may not call HTTP at
 * all (the browser blocks it as mixed content). Production builds set
 * VITE_WRITE_URL=/api/write and VITE_READ_URL=/api/read, which makes every
 * call same-origin - so the reverse proxy routes them and CORS stops applying
 * entirely.
 */
const host = typeof window === 'undefined' ? 'localhost' : window.location.hostname;

/** Vite replaces missing env vars with an empty string, not undefined. */
const configured = (value: string | undefined, fallback: string) =>
  value && value.length > 0 ? value : fallback;

export const WRITE_URL = configured(import.meta.env.VITE_WRITE_URL, `http://${host}:4000`);
export const READ_URL = configured(import.meta.env.VITE_READ_URL, `http://${host}:4001`);

/** Fixed id, so the pipeline monitor can show money in flight without a lookup. */
export const CLEARING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

export const REQUEST_TIMEOUT_MS = 8_000;
