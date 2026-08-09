import { useEffect, useRef, useState } from 'react';
import { READ_URL } from '../lib/config';
import type { DeadLetter, StreamEvent } from '../types/api';

interface Handlers {
  onEvent?: (payload: StreamEvent) => void;
  onDeadLetter?: (entry: DeadLetter) => void;
}

/**
 * Subscribes to the query service's Server-Sent Events stream.
 *
 * SSE rather than WebSockets because all the traffic is server to client and
 * EventSource reconnects on its own - which is most of the reason it was
 * chosen, and why there is no reconnect logic here to get wrong.
 *
 * Handlers are held in a ref so a re-render with a new closure does not tear
 * down and rebuild the connection; dropping the stream on every state change
 * would mean missing events during the gap.
 */
export function useEventStream(handlers: Handlers): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const stream = new EventSource(`${READ_URL}/events/stream`);

    stream.addEventListener('hello', () => setConnected(true));
    stream.onerror = () => setConnected(false);

    stream.addEventListener('payment-event', (message) => {
      setConnected(true);
      try {
        handlersRef.current.onEvent?.(JSON.parse((message as MessageEvent).data));
      } catch {
        // A frame we cannot parse is not worth taking the page down for.
      }
    });

    stream.addEventListener('dead-letter', (message) => {
      try {
        handlersRef.current.onDeadLetter?.(JSON.parse((message as MessageEvent).data));
      } catch {
        /* ignore */
      }
    });

    return () => stream.close();
  }, []);

  return { connected };
}
