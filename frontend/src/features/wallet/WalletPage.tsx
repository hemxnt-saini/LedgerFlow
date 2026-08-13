import { useEffect, useMemo, useState } from 'react';
import { getPayment } from '../../api/payments';
import { PageShell } from '../../components/PageShell';
import { useAppStream } from '../../hooks/useAppStream';
import { useRelativeTimeTick } from '../../hooks/useRelativeTimeTick';
import { useToasts } from '../../hooks/useToasts';
import type { Payment } from '../../types/api';
import { ArchitectureCard } from '../overview/ArchitectureCard';
import { SystemPanel } from '../overview/SystemPanel';
import { useSystemStatus } from '../overview/useSystemStatus';
import { AccountMenu } from './AccountMenu';
import { ActivityFeed } from './ActivityFeed';
import { BalanceCard } from './BalanceCard';
import { FriendsList } from './FriendsList';
import { LimitsCard } from './LimitsCard';
import { LoginScreen } from './LoginScreen';
import { PaymentDetailModal } from './PaymentDetailModal';
import { SagaProgressModal } from './SagaProgressModal';
import { SendMoneyModal } from './SendMoneyModal';
import { StatsPanel } from './StatsPanel';
import { TransactionList } from './TransactionList';
import { useWalletData } from './useWalletData';

export function WalletPage() {
  const { toast } = useToasts();
  const wallet = useWalletData();
  const { connected, subscribe, setIdentity } = useAppStream();

  const [sendOpen, setSendOpen] = useState(false);
  const [sendPreset, setSendPreset] = useState<string | null>(null);
  const [watched, setWatched] = useState<Payment | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  // Relative timestamps go stale on a page nobody touches.
  useRelativeTimeTick();

  const { meId, me, nameOf, scheduleRefresh, reloadAccounts } = wallet;

  // The wallet decides who the notifications are about; the provider decides
  // what to say and keeps them across navigation.
  useEffect(() => {
    setIdentity({ meId, nameOf });
  }, [setIdentity, meId, nameOf]);

  useEffect(
    () =>
      subscribe(({ event }) => {
        if (event.type === 'account.created') {
          void reloadAccounts().then(scheduleRefresh);
          return;
        }

        // If the progress modal is watching this payment, advance it in place.
        setWatched((current) => {
          if (current && event.paymentId === current.id && event.type !== 'payment.initiated') {
            getPayment(current.id)
              .then((fresh) => setWatched((live) => (live?.id === fresh.id ? fresh : live)))
              .catch(() => undefined);
          }
          return current;
        });

        scheduleRefresh();
      }),
    [subscribe, reloadAccounts, scheduleRefresh],
  );


  const signedIn = Boolean(me);
  // Polled only while signed out, where it is the landing page's content.
  const system = useSystemStatus(!signedIn);
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

  // Signed out, the landing has to say what this is. A bare "who are you?"
  // reads as a toy; the system panel above the picker reads as a platform.
  if (!signedIn) {
    return (
      <PageShell logo="brand" title="LedgerFlow" subtitle="event-driven payments">
        <SystemPanel status={system} />
        <LoginScreen
          hidden={false}
          accounts={wallet.accounts}
          onSignIn={wallet.signIn}
          onAccountCreated={wallet.reloadAccounts}
        />
        <ArchitectureCard />
      </PageShell>
    );
  }

  return (
    <>
      <div id="app">
        <PageShell
          logo="W"
          title="Wallet"
          connected={connected}
          actions={
            me && (
              <AccountMenu
                me={me}
                accounts={wallet.accounts}
                balances={wallet.balances}
                onSwitch={wallet.signIn}
                onSignOut={wallet.signOut}
              />
            )
          }
        >
          {meId && (
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
          )}
        </PageShell>
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
