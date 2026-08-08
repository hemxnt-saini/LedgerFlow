import type { Response } from 'express';
import { config } from '../config';

/**
 * The live push channel: every open browser tab, held on a Server-Sent Events
 * stream.
 *
 * SSE rather than WebSockets because all the traffic is server to client,
 * EventSource reconnects on its own, and it needs no library on either end.
 */
const subscribers = new Set<Response>();

export const subscriberCount = (): number => subscribers.size;

export function subscribe(res: Response): () => void {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx would otherwise buffer the stream and deliver nothing until it
    // decides the response is finished.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ connected: true })}\n\n`);
  subscribers.add(res);
  return () => subscribers.delete(res);
}

export function broadcast(name: string, data: unknown): void {
  const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of subscribers) client.write(frame);
}

/** A comment line is the cheapest way to keep an idle stream warm. */
export function startKeepAlive(): NodeJS.Timeout {
  return setInterval(() => {
    for (const client of subscribers) client.write(': keep-alive\n\n');
  }, config.streamKeepAliveMs);
}

export function closeAll(): void {
  for (const client of subscribers) client.end();
  subscribers.clear();
}
