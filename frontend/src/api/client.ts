import { REQUEST_TIMEOUT_MS } from '../lib/config';

/** An error carrying the backend's machine-readable code, not just a message. */
export class ApiError extends Error {
  constructor(
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(code ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

/**
 * Never hang forever.
 *
 * A browser allows only six connections per origin over HTTP/1.1, and each
 * tab's event stream permanently holds one of them - so with enough tabs of
 * this app open, a request can queue indefinitely. A request that cannot
 * finish should say so rather than spin.
 */
export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error, res.status);
  return body as T;
}

/** Some responses matter as much for their headers as their body. */
export async function requestWithHeaders<T>(
  url: string,
  options: RequestInit = {},
): Promise<{ body: T; headers: Headers }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error, res.status);
  return { body: body as T, headers: res.headers };
}

export const jsonHeaders = { 'Content-Type': 'application/json' };
