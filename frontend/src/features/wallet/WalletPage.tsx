import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPayment } from '../../api/payments';
import { LiveDot } from '../../components/LiveDot';
import { useEventStream } from '../../hooks/useEventStream';
import { useRelativeTimeTick } from '../../hooks/useRelativeTimeTick';
import { useToasts } from '../../hooks/useToasts';
import { humanise } from '../../lib/labels';
import { fmt } from '../../lib/money';
import type { Payment, StreamEvent } from '../../types/api';
import { ActivityFeed } from './ActivityFeed';
import { BalanceCard } from './BalanceCard';
import { FriendsList } from './FriendsList';
import { LimitsCard } from './LimitsCard';
import { LoginScreen } from './LoginScreen';
import { NotificationBell } from './NotificationBell';
import { PaymentDetailModal } from './PaymentDetailModal';
import { SagaProgressModal } from './SagaProgressModal';
import { SendMoneyModal } from './SendMoneyModal';
import { StatsPanel } from './StatsPanel';
import { TransactionList } from './TransactionList';
import { useNotifications, useWalletData } from './useWalletData';

export function WalletPage() {
  const { toast } = useToasts();
  const wallet = useWalletData();
  const notifications = useNotifications(wallet.meId);

  const [sendOpen, setSendOpen] = useState(false);
  const [sendPreset, setSendPreset] = useState<string | null>(null);
  const [watched, setWatched] = useState<Payment | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  // Relative timestamps go stale on a page nobody touches.
  useRelativeTimeTick();

  const { meId, me, nameOf, scheduleRefresh, reloadAccounts } = wallet;

  const handleEvent = useCallback(
    ({ event }: StreamEvent) => {
      if (event.type === 'account.created') {
        void reloadAccounts().then(scheduleRefresh);
        return;
      }

      const outgoing = event.fromAccountId === meId;
      const incoming = event.toAccountId === meId;
      if (outgoing || incoming) {
        const other = nameOf(outgoing ? event.toAccountId : event.fromAccountId);
        const amount = fmt(event.amountCents);
        const alert = (text: string, tone: 'good' | 'bad' | 'warn') => {
          notifications.push(text);
          toast(text, tone);
        };

        if (event.type === 'payment.completed') {
          alert(
            outgoing ? `You paid ${other} ${amount}` : `${other} sent you ${amount}`,
            'good',
          );
        } else if (event.type === 'payment.failed' && outgoing) {
          alert(
            `Payment to ${other} declined: ${humanise(event.failureReason)}`,
            'bad',
          );
        } else if (event.type === 'payment.held' && outgoing) {
          alert(`${amount} to ${other} is held for review`, 'warn');
        } else if (event.type === 'payment.approved' && outgoing) {
          alert(`${amount} to ${other} was released by a reviewer`, 'good');
        } else if (event.type === 'payment.stuck' && outgoing) {
          alert(`${amount} to ${other} is stuck - a refund is on its way`, 'warn');
        } else if (event.type === 'payment.refunded' && outgoing) {
          alert(`${amount} refunded to you`, 'warn');
        }
      }

      // If the progress modal is watching this payment, advance it in place.
      setWatched((current) => {
        if (
          current &&
          event.paymentId === current.id &&
          event.type !== 'payment.initiated'
        ) {
          getPayment(current.id)
            .then((fresh) => setWatched((live) => (live?.id === fresh.id ? fresh : live)))
            .catch(() => undefined);
        }
        return current;
      });

      scheduleRefresh();
    },
    [meId, nameOf, notifications, scheduleRefresh, reloadAccounts, toast],
  );

  const { connected } = useEventStream({ onEvent: handleEvent });

  const signedIn = Boolean(me);
  const friends = useMemo(
    () => wallet.accounts.filter((account) => account.id !== meId),
    [wallet.accounts, meId],
  );
  const inFlight = useMemo(
    () =>
      wallet.transactions.filter(
        (txn) => txn.status === 'PROCESSING' && txn.fromAccountId === meId,
      ),
    [wallet.transactions, meId],
  );

  const balanceCents = meId
    ? (wallet.balances[meId] ?? me?.balanceCents ?? 0)
    : 0;

  function openSend(presetFriendId?: string) {
    if (friends.length === 0) {
      toast('There is nobody to pay yet - create another account first.', 'warn');
      return;
    }
    setSendPreset(presetFriendId ?? null);
    setSendOpen(true);
  }

  if (wallet.offline) {
    return (
      <div className="empty" style={{ margin: '10vh auto', maxWidth: 520 }}>
        Cannot reach the payment service on :4000. Is docker compose up running?
      </div>
    );
  }

  // Until the account list is in, we cannot tell a signed-in user from a
  // signed-out one - and flashing the login screen at someone who is already
  // signed in looks like being logged out.
  if (!wallet.ready) return null;

  return (
    <>
      <LoginScreen
        hidden={signedIn}
        accounts={wallet.accounts}
        onSignIn={wallet.signIn}
        onAccountCreated={wallet.reloadAccounts}
      />

      <div id="app" className={signedIn ? undefined : 'hidden'}>
        <header className="topbar">
          <div className="brand">
            <div className="logo">W</div>
            <div>
              <h1>Wallet</h1>
              <div className="tiny muted">
                <LiveDot connected={connected} />
              </div>
            </div>
          </div>

          <div className="row">
            <Link className="small muted" to="/ledger">
              Ledger →
            </Link>
            <Link className="small muted" to="/ops">
              Reviews →
            </Link>
            <Link className="small muted" to="/controls">
              Controls →
            </Link>
            <Link className="small muted" to="/kafka">
              Kafka →
            </Link>
            <Link className="small muted" to="/pipeline">
              Pipeline →
            </Link>
            <NotificationBell
              items={notifications.items}
              unread={notifications.unread}
              onOpen={notifications.markRead}
              onClear={notifications.clear}
            />
            <button id="switch-user" className="ghost small" onClick={wallet.signOut}>
              <span id="me-name">{me?.name ?? '…'}</span> ⌄
            </button>
          </div>
        </header>

        {signedIn && meId && (
          <main>
            <div className="grid">
              <div>
                <BalanceCard
                  balanceCents={balanceCents}
                  inFlight={inFlight}
                  onSend={() => openSend()}
                />
                <LimitsCard data={wallet.limits} />
                <StatsPanel stats={wallet.stats} inFlightCount={inFlight.length} />
                <TransactionList
                  transactions={wallet.transactions}
                  meId={meId}
                  nameOf={nameOf}
                  loading={!wallet.hydrated}
                  onOpen={setDetailId}
                />
              </div>

              <div>
                <FriendsList
                  friends={friends}
                  balances={wallet.balances}
                  onPay={(id) => openSend(id)}
                />
                <ActivityFeed activity={wallet.activity} nameOf={nameOf} />
              </div>
            </div>
          </main>
        )}
      </div>

      {sendOpen && meId && me && (
        <SendMoneyModal
          friends={friends}
          meId={meId}
          meName={me.name}
          balanceCents={balanceCents}
          limits={wallet.limits}
          presetFriendId={sendPreset}
          nameOf={nameOf}
          onClose={() => setSendOpen(false)}
          onSent={(payment) => {
            setSendOpen(false);
            setWatched(payment);
            scheduleRefresh();
          }}
        />
      )}

      {watched && (
        <SagaProgressModal
          payment={watched}
          nameOf={nameOf}
          onClose={() => setWatched(null)}
        />
      )}

      {detailId && meId && (
        <PaymentDetailModal
          paymentId={detailId}
          meId={meId}
          nameOf={nameOf}
          onClose={() => setDetailId(null)}
        />
      )}
    </>
  );
}
