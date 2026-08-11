import { useState } from 'react';
import { ApiError } from '../../api/client';
import { refundPayment } from '../../api/payments';
import { Modal } from '../../components/Modal';
import { useToasts } from '../../hooks/useToasts';
import { humanise } from '../../lib/labels';
import { fmt } from '../../lib/money';
import type { Payment, PaymentStatus } from '../../types/api';

type Mark = 'done' | 'active' | 'todo' | 'error' | 'warn';

/**
 * The saga, watched live.
 *
 * Three steps, because that is genuinely what happens: the money is taken and
 * held, then it is moved on, then it either arrives or comes back. Showing it
 * as a spinner would hide the one thing worth seeing.
 */
const BASE_STEPS: [string, string][] = [
  ['Payment authorised', 'Money taken from your balance and held in the clearing account.'],
  ['Settling', 'Moving the held funds on to the receiver.'],
  ['Done', ''],
];

const MARKS: Record<PaymentStatus, Mark[]> = {
  PROCESSING: ['done', 'active', 'todo'],
  // The money is safely held; nothing is wrong, it is simply paused.
  HELD_FOR_REVIEW: ['done', 'warn', 'todo'],
  COMPLETED: ['done', 'done', 'done'],
  FAILED: ['error', 'todo', 'todo'],
  AWAITING_REFUND: ['done', 'error', 'warn'],
  REFUNDED: ['done', 'error', 'done'],
};

const GLYPH: Record<Mark, string> = {
  done: '✓',
  error: '!',
  warn: '⟲',
  active: '',
  todo: '',
};

function labelsFor(payment: Payment, nameOf: (id: string) => string): [string, string][] {
  const labels = BASE_STEPS.map((step) => [...step] as [string, string]);
  const reason = humanise(payment.failureReason);

  switch (payment.status) {
    case 'FAILED':
      labels[0] = ['Declined', reason];
      break;
    case 'AWAITING_REFUND':
      labels[1] = ['Settlement failed', reason];
      labels[2] = [
        'Refund pending',
        'Your money is in clearing and is being returned automatically.',
      ];
      break;
    case 'REFUNDED':
      labels[1] = ['Settlement failed', reason];
      labels[2] = ['Refunded', 'Every cent is back in your balance.'];
      break;
    case 'HELD_FOR_REVIEW':
      labels[1] = [
        'Held for review',
        'Your money is secured in the clearing account while this is checked.',
      ];
      labels[2] = ['Awaiting a decision', ''];
      break;
    case 'COMPLETED':
      labels[2] = ['Delivered', `${nameOf(payment.toAccountId)} has the money.`];
      break;
    default:
      break;
  }
  return labels;
}

interface Props {
  payment: Payment;
  nameOf: (id: string) => string;
  onClose: () => void;
}

export function SagaProgressModal({ payment, nameOf, onClose }: Props) {
  const { toast } = useToasts();
  const [refunding, setRefunding] = useState(false);

  const marks = MARKS[payment.status];
  const labels = labelsFor(payment, nameOf);
  const settled =
    payment.status !== 'PROCESSING' && payment.status !== 'HELD_FOR_REVIEW';

  const tone =
    payment.status === 'COMPLETED'
      ? 'good'
      : payment.status === 'REFUNDED' || payment.status === 'AWAITING_REFUND'
        ? 'warn'
        : 'bad';
  const resultGlyph =
    payment.status === 'COMPLETED' ? '✓' : payment.status === 'FAILED' ? '✕' : '⟲';

  async function refundNow() {
    setRefunding(true);
    try {
      await refundPayment(payment.id);
      // The stream will bring the REFUNDED state back and re-render this.
    } catch (err) {
      toast(humanise(err instanceof ApiError ? err.code : undefined), 'bad');
      setRefunding(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Sending payment</h2>
      <div className="review-amount">{fmt(payment.amountCents)}</div>

      <div className="steps" id="saga-steps">
        {labels.map(([title, detail], index) => {
          const mark = marks[index];
          return (
            <div className={`step ${mark}`} key={title}>
              <div className="dot">{GLYPH[mark]}</div>
              <div className="body stack">
                <div>{title}</div>
                {detail && <div className="tiny muted">{detail}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <div id="saga-footer">
        {!settled ? (
          <div className="tiny muted">
            {payment.status === 'HELD_FOR_REVIEW'
              ? 'A reviewer has to release this before it can settle.'
              : 'Watching the event stream…'}
          </div>
        ) : (
          <>
            <div className={`result-icon ${tone}`}>{resultGlyph}</div>
            <div className="row">
              {payment.status === 'AWAITING_REFUND' && (
                <button className="primary grow" disabled={refunding} onClick={refundNow}>
                  {refunding ? 'Refunding…' : 'Refund now'}
                </button>
              )}
              <button
                className={
                  payment.status === 'AWAITING_REFUND' ? 'grow' : 'primary grow'
                }
                onClick={onClose}
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
