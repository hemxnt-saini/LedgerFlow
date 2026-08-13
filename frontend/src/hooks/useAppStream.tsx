import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useEventStream } from './useEventStream';
import { useToasts } from './useToasts';
import { humanise } from '../lib/labels';
import { fmt } from '../lib/money';
import type { StreamEvent } from '../types/api';

export interface Notification {
  text: string;
  at: string;
}

interface Identity {
  meId: string | null;
  nameOf: (id: string) => string;
}

interface AppStreamApi {
  connected: boolean;
  /** Extra work a page wants done per event. Returns an unsubscribe. */
  subscribe: (handler: (payload: StreamEvent) => void) => () => void;
  /** Who the notifications are being written for. Set by the wallet. */
  setIdentity: (identity: Identity) => void;
  notifications: {
    items: Notification[];
    unread: number;
    markRead: () => void;
    clear: () => void;
  };
}

const AppStreamContext = createContext<AppStreamApi | null>(null);

/**
 * What an event means to the person looking at it, or null if it means
 * nothing to them.
 *
 * Pure, and separate from the plumbing, because "was this worth telling you
 * about" is the only interesting decision here.
 *
 * `keep` is what separates the bell from a toast. A toast acknowledges what
 * you just did and is fine to miss; the bell is for things that happened *to*
 * you or went wrong, which are worth finding later.
 */
function describe(
  event: StreamEvent['event'],
  { meId, nameOf }: Identity,
): { text: string; tone: 'good' | 'bad' | 'warn'; keep: boolean } | null {
  if (!meId) return null;
  const outgoing = event.fromAccountId === meId;
  const incoming = event.toAccountId === meId;
  if (!outgoing && !incoming) return null;

  const other = nameOf(outgoing ? event.toAccountId : event.fromAccountId);
  const amount = fmt(event.amountCents);

  switch (event.type) {
    case 'payment.completed':
      return {
        text: outgoing ? `You paid ${other} ${amount}` : `${other} sent you ${amount}`,
        tone: 'good',
        keep: !outgoing,
      };
    case 'payment.failed':
      return outgoing
        ? {
            text: `Payment to ${other} declined: ${humanise(event.failureReason)}`,
            tone: 'bad',
            keep: true,
          }
        : null;
    case 'payment.held':
      return outgoing
        ? { text: `${amount} to ${other} is held for review`, tone: 'warn', keep: true }
        : null;
    case 'payment.approved':
      // The hold needed attention; being released is only the all-clear.
      return outgoing
        ? { text: `${amount} to ${other} was released by a reviewer`, tone: 'good', keep: false }
        : null;
    case 'payment.stuck':
      return outgoing
        ? {
            text: `${amount} to ${other} is stuck - a refund is on its way`,
            tone: 'warn',
            keep: true,
          }
        : null;
    case 'payment.refunded':
      return outgoing ? { text: `${amount} refunded to you`, tone: 'warn', keep: true } : null;
    default:
      return null;
  }
}

const MAX_NOTIFICATIONS = 50;

/**
 * One event stream and one notification list, for the whole app.
 *
 * Both used to live inside the wallet page, which had two consequences that
 * only show up once you navigate: the list was thrown away every time the
 * page unmounted, and while you were on any other page nothing was listening
 * at all - so money arriving while you read the ledger was not merely unshown,
 * it was missed.
 *
 * Lifting them here fixes both and keeps a single EventSource. That last part
 * matters: a browser allows six connections per origin over HTTP/1.1 and each
 * stream holds one open permanently, so a second subscription per page is a
 * cost the app cannot afford.
 */
export function AppStreamProvider({ children }: { children: ReactNode }) {
  const { toast } = useToasts();
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  const handlers = useRef(new Set<(payload: StreamEvent) => void>());
  const identity = useRef<Identity>({ meId: null, nameOf: (id) => id });

  const setIdentity = useCallback((next: Identity) => {
    // Switching user starts a fresh session; the previous person's alerts are
    // not this person's business.
    if (next.meId !== identity.current.meId) {
      setItems([]);
      setUnread(0);
    }
    identity.current = next;
  }, []);

  const onEvent = useCallback(
    (payload: StreamEvent) => {
      const note = describe(payload.event, identity.current);
      if (note) {
        toast(note.text, note.tone);
        if (note.keep) {
          setItems((current) =>
            [{ text: note.text, at: new Date().toISOString() }, ...current].slice(
              0,
              MAX_NOTIFICATIONS,
            ),
          );
          setUnread((count) => count + 1);
        }
      }
      for (const handler of handlers.current) handler(payload);
    },
    [toast],
  );

  const { connected } = useEventStream({ onEvent });

  const subscribe = useCallback((handler: (payload: StreamEvent) => void) => {
    handlers.current.add(handler);
    return () => {
      handlers.current.delete(handler);
    };
  }, []);

  const markRead = useCallback(() => setUnread(0), []);
  const clear = useCallback(() => {
    setItems([]);
    setUnread(0);
  }, []);

  const value = useMemo<AppStreamApi>(
    () => ({
      connected,
      subscribe,
      setIdentity,
      notifications: { items, unread, markRead, clear },
    }),
    [connected, subscribe, setIdentity, items, unread, markRead, clear],
  );

  return <AppStreamContext.Provider value={value}>{children}</AppStreamContext.Provider>;
}

export function useAppStream(): AppStreamApi {
  const context = useContext(AppStreamContext);
  if (!context) throw new Error('useAppStream must be used inside an AppStreamProvider');
  return context;
}
