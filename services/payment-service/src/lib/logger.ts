import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { config } from '../config';

/**
 * Structured logging with a correlation id that survives the hop through
 * Kafka.
 *
 * The point is not JSON. The point is that one payment produces log lines in
 * the payment service, in three different background workers, and again in
 * the query service after a trip through a broker - and all of them carry the
 * same `correlationId`, so the whole journey is one grep.
 *
 * The id lives in AsyncLocalStorage rather than being passed down through
 * every function signature. Anything running inside a request or a message
 * handler picks it up automatically.
 *
 * No dependency: this is a few lines around console, and a logging library
 * would earn its place only once shipping and sampling are real requirements.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[config.logLevel as Level] ?? LEVELS.info;
const SERVICE = config.serviceName;

export interface LogContext {
  correlationId?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs fn with this context attached to every log line it produces. */
export const withContext = <T>(context: LogContext, fn: () => T): T =>
  storage.run({ ...storage.getStore(), ...context }, fn);

export const currentContext = (): LogContext => storage.getStore() ?? {};
export const currentCorrelationId = (): string | undefined =>
  storage.getStore()?.correlationId;

export const newCorrelationId = (): string => randomUUID();

function emit(level: Level, message: string, fields: LogContext = {}): void {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    svc: SERVICE,
    msg: message,
    ...currentContext(),
    ...fields,
  };
  // One JSON object per line: greppable with jq, parseable by anything, and
  // never interleaved halfway through a message the way multi-line output is.
  const text = JSON.stringify(line, (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message } : value,
  );
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export interface Logger {
  debug(message: string, fields?: LogContext): void;
  info(message: string, fields?: LogContext): void;
  warn(message: string, fields?: LogContext): void;
  error(message: string, fields?: LogContext): void;
  /** A logger with extra fields permanently attached. */
  child(fields: LogContext): Logger;
}

function make(bound: LogContext): Logger {
  return {
    debug: (message, fields) => emit('debug', message, { ...bound, ...fields }),
    info: (message, fields) => emit('info', message, { ...bound, ...fields }),
    warn: (message, fields) => emit('warn', message, { ...bound, ...fields }),
    error: (message, fields) => emit('error', message, { ...bound, ...fields }),
    child: (fields) => make({ ...bound, ...fields }),
  };
}

export const log = make({});
