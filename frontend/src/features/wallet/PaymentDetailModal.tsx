import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { getPayment, refundPayment } from '../../api/payments';
import { StatusBadge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { Modal, ReviewLine } from '../../components/Modal';
import { Skeleton } from '../../components/Skeleton';
import { useToasts } from '../../hooks/useToasts';
import { humanise } from '../../lib/labels';
import { fmt } from '../../lib/money';
import type { PaymentWithLedger } from '../../types/api';

interface Props {
  paymentId: string;
  meId: string;
  nameOf: (id: string) => string;
  onClose: () => void;
}

/** The audit trail behind a payment: its status and every ledger leg. */
export function PaymentDetailModal({ paymentId, meId, nameOf, onClose }: Props) {
  const { toast } = useToasts();
  const [payment, setPayment] = useState<PaymentWithLedger | null>(null);
  const [refunding, setRefunding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPayment(paymentId)
      .then((result) => {
        if (!cancelled) setPayment(result);
      })
      .catch((err) => {
        if (cancelled) return;
        onClose();
        toast(humanise(err instanceof ApiError ? err.code : undefined), 'bad');
      });
    return () => {
      cancelled = true;
    };
  }, [paymentId, onClose, toast]);

  if (!payment) {
    return (
      <Modal onClose={onClose}>
        <h2>Payment</h2>
        <div style={{ marginTop: 14 }}>
          <Skeleton />
        </div>
      </Modal>
    );
  }

  async function refundNow() {
    if (!payment) return;
    setRefunding(true);
    try {
      await refundPayment(payment.id);
      onClose();
      toast('Refunded - the money is back in your balance.', 'good');
    } catch (err) {
      setRefunding(false);
      toast(humanise(err instanceof ApiError ? err.code : undefined), 'bad');
    }
  }

  const outgoing = payment.fromAccountId === meId;

  return (
    <Modal onClose={onClose}>
      <h2>Payment</h2>
      <div className="review-amount">{fmt(payment.amountCents)}</div>

      <div className="row" style={{ justifyContent: 'center' }}>
        <StatusBadge status={payment.status} />
      </div>

      <div style={{ marginTop: 12 }}>
        <ReviewLine small label="From" value={nameOf(payment.fromAccountId)} />
        <ReviewLine small label="To" value={nameOf(payment.toAccountId)} />
        <ReviewLine small label="Direction" value={outgoing ? 'Sent' : 'Received'} />
        <ReviewLine small label="Note" value={payment.note || '—'} />
        <ReviewLine small label="Created" value={new Date(payment.createdAt).toLocaleString()} />
        <ReviewLine small label="Updated" value={new Date(payment.updatedAt).toLocaleString()} />
        {payment.failureReason && (
          <ReviewLine small label="Reason" value={humanise(payment.failureReason)} />
        )}
      </div>

      <h3>Ledger entries</h3>
      <div className="list" style={{ marginTop: 8 }}>
        {payment.ledger.length === 0 ? (
          <EmptyState>No money moved, so nothing was written to the ledger.</EmptyState>
        ) : (
          payment.ledger.map((entry, index) => (
            <div className="item flat" key={`${entry.leg}-${entry.direction}-${index}`}>
              <div className="grow stack">
                <div className="small">{`${entry.leg} · ${entry.direction} ${entry.accountName}`}</div>
                <div className="tiny muted">
                  {new Date(entry.createdAt).toLocaleTimeString()}
                </div>
              </div>
              <div className={`amount ${entry.direction === 'DEBIT' ? 'out' : 'in'}`}>
                {fmt(entry.amountCents)}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="tiny muted">
        Every leg is one debit and one credit. A refund appends new opposite entries -
        nothing is ever edited or deleted.
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        {payment.status === 'AWAITING_REFUND' && (
          <button className="danger grow" disabled={refunding} onClick={refundNow}>
            {refunding ? 'Refunding…' : 'Refund now'}
          </button>
        )}
        <button className="primary grow" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
