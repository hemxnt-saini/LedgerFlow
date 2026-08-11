import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listAccounts } from '../../api/accounts';
import { ApiError } from '../../api/client';
import { approvePayment, listReviews, rejectPayment } from '../../api/payments';
import { Card, CardHead } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { LiveDot } from '../../components/LiveDot';
import { Skeleton } from '../../components/Skeleton';
import { useEventStream } from '../../hooks/useEventStream';
import { useToasts } from '../../hooks/useToasts';
import { holdReason, humanise } from '../../lib/labels';
import { fmt } from '../../lib/money';
import { ago } from '../../lib/time';
import type { Account, Payment } from '../../types/api';
import './ops.css';

/**
 * The review queue.
 *
 * Everything here has already been authorised - the sender is debited and the
 * money is sitting in the clearing account. That is what makes a hold safe to
 * leave alone: the funds cannot be spent twice while someone decides, and the
 * ledger balances the whole time it waits.
 *
 * Approving puts the payment back on the ordinary settlement path. Rejecting
 * runs the same compensating action a stranded payment uses.
 */
export function OpsPage() {
  const { toast } = useToasts();
  const [reviews, setReviews] = useState<Payment[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [queue, roster] = await Promise.all([listReviews(), listAccounts(true)]);
      setReviews(queue.reviews);
      setAccounts(roster);
    } catch {
      setReviews([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A payment can be held while this page is open, and someone else may be
  // working the same queue.
  const { connected } = useEventStream({ onEvent: useCallback(() => void load(), [load]) });

  const nameOf = (id: string) =>
    accounts.find((account) => account.id === id)?.name ?? `${id.slice(0, 8)}…`;

  async function decide(payment: Payment, action: 'approve' | 'reject') {
    setBusy(payment.id);
    try {
      await (action === 'approve' ? approvePayment : rejectPayment)(payment.id);
      toast(
        action === 'approve'
          ? `Released ${fmt(payment.amountCents)} to ${nameOf(payment.toAccountId)}.`
          : `Refused ${fmt(payment.amountCents)} - returned to ${nameOf(payment.fromAccountId)}.`,
        action === 'approve' ? 'good' : 'warn',
      );
    } catch (err) {
      toast(humanise(err instanceof ApiError ? err.code : undefined), 'bad');
    } finally {
      setBusy(null);
      await load();
    }
  }

  const held = reviews ?? [];
  const heldCents = held.reduce((sum, payment) => sum + payment.amountCents, 0);

  return (
    <div className="page-ops">
      <header className="topbar">
        <div className="brand">
          <div className="logo">⚑</div>
          <div>
            <h1>Review queue</h1>
            <div className="tiny muted">
              <LiveDot connected={connected} /> · <Link to="/">wallet</Link> ·{' '}
              <Link to="/ledger">ledger</Link> · <Link to="/controls">controls</Link>
            </div>
          </div>
        </div>
        <button className="ghost small" id="ops-refresh" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      <main>
        <Card>
          <CardHead title="Waiting on a decision" aside={`${held.length} payment(s)`} />
          <div className="stats">
            <div className="stat">
              <div className="k">In the queue</div>
              <div className="v" id="review-count">
                {held.length}
              </div>
            </div>
            <div className="stat">
              <div className="k">Value held</div>
              <div className="v" id="review-value">
                {fmt(heldCents)}
              </div>
            </div>
            <div className="stat">
              <div className="k">Oldest</div>
              <div className="v">{held.length ? ago(held[0].createdAt) : '—'}</div>
            </div>
            <div className="stat">
              <div className="k">Where the money is</div>
              <div className="v">Clearing</div>
            </div>
          </div>
          <p className="tiny muted" style={{ marginTop: 10, marginBottom: 0 }}>
            Every payment here is already authorised — the sender has been debited and the
            funds are in the clearing account. Securing the money first is what makes a
            hold safe: it cannot be spent elsewhere while someone deliberates, and the
            books balance the entire time it waits.
          </p>
        </Card>

        <Card>
          <CardHead title="Queue" aside="oldest first" />
          <div id="reviews" className="list">
            {reviews === null ? (
              <Skeleton />
            ) : held.length === 0 ? (
              <EmptyState>
                Nothing waiting. Send more than $500, or $200 to someone new, and it lands
                here.
              </EmptyState>
            ) : (
              held.map((payment) => (
                <div className="review" key={payment.id}>
                  <div>
                    <div className="amount-big">{fmt(payment.amountCents)}</div>
                    <div className="small">
                      {`${nameOf(payment.fromAccountId)} → ${nameOf(payment.toAccountId)}`}
                      {payment.note ? ` · ${payment.note}` : ''}
                    </div>
                    <div className="tiny muted">{ago(payment.createdAt)}</div>
                    <div className="flags">
                      {payment.holdReasons.map((reason) => (
                        <span className="flag" key={reason}>
                          {holdReason(reason)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="decide">
                    <button
                      className="primary"
                      disabled={busy === payment.id}
                      onClick={() => decide(payment, 'approve')}
                    >
                      Release
                    </button>
                    <button
                      className="danger"
                      disabled={busy === payment.id}
                      onClick={() => decide(payment, 'reject')}
                    >
                      Refuse
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <p className="tiny muted" style={{ marginTop: 10, marginBottom: 0 }}>
            <strong>Release</strong> puts the payment back on the ordinary settlement path
            rather than settling it here, so there is one route to completion and the
            retry and compensation behaviour is unchanged. <strong>Refuse</strong> runs the
            same compensating action a stranded payment uses — the sender gets every cent
            back and the original entry stays in the journal.
          </p>
        </Card>
      </main>
    </div>
  );
}
