import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { sendPayment } from '../../api/payments';
import { Modal, ReviewLine } from '../../components/Modal';
import { useToasts } from '../../hooks/useToasts';
import { humanise } from '../../lib/labels';
import { fmt, toCents } from '../../lib/money';
import type { Account, Payment, SimulateMode } from '../../types/api';

interface Draft {
  toAccountId: string;
  amountCents: number;
  note: string;
  simulate: SimulateMode;
}

interface Props {
  friends: Account[];
  meId: string;
  meName: string;
  balanceCents: number;
  presetFriendId?: string | null;
  nameOf: (id: string) => string;
  onClose: () => void;
  onSent: (payment: Payment) => void;
}

/** Steps 1 and 2 of the send flow: compose, then confirm before money moves. */
export function SendMoneyModal({
  friends,
  meId,
  meName,
  balanceCents,
  presetFriendId,
  nameOf,
  onClose,
  onSent,
}: Props) {
  const { toast } = useToasts();
  const [draft, setDraft] = useState<Draft | null>(null);

  const [to, setTo] = useState(presetFriendId ?? friends[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [simulate, setSimulate] = useState<SimulateMode>('NONE');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  function review(event: FormEvent) {
    event.preventDefault();
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }

    const amountCents = toCents(dollars);
    // Over-balance is a warning, not a block: the backend is the authority on
    // whether it can be paid, and watching it get declined is informative.
    if (amountCents > balanceCents) {
      setError(`That is more than your ${fmt(balanceCents)} balance. It will be declined.`);
    } else {
      setError(null);
    }

    setDraft({ toAccountId: to, amountCents, note: note.trim(), simulate });
  }

  async function confirm() {
    if (!draft) return;
    setSending(true);
    try {
      const payment = await sendPayment({
        fromAccountId: meId,
        toAccountId: draft.toAccountId,
        amountCents: draft.amountCents,
        note: draft.note,
        simulate: draft.simulate,
      });
      onSent(payment);
    } catch (err) {
      setSending(false);
      toast(humanise(err instanceof ApiError ? err.code : undefined), 'bad');
    }
  }

  if (draft) {
    return (
      <Modal onClose={onClose}>
        <h2>Review payment</h2>
        <div className="review-amount">{fmt(draft.amountCents)}</div>

        <ReviewLine label="From" value={meName} />
        <ReviewLine label="To" value={nameOf(draft.toAccountId)} />
        <ReviewLine label="Note" value={draft.note || '—'} />
        {draft.simulate !== 'NONE' && (
          <ReviewLine
            label="Mode"
            value={
              draft.simulate === 'TRANSIENT'
                ? 'Transient fault (recovers)'
                : 'Permanent fault (refunds)'
            }
          />
        )}

        <div className="row" style={{ marginTop: 18 }}>
          <button className="grow" onClick={() => setDraft(null)}>
            Back
          </button>
          <button className="primary grow" disabled={sending} onClick={confirm}>
            {sending ? 'Sending…' : 'Confirm & send'}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <h2>Send money</h2>
      <form style={{ marginTop: 14 }} onSubmit={review}>
        <label className="field">
          <span>To</span>
          <select id="send-to" value={to} onChange={(event) => setTo(event.target.value)}>
            {friends.map((friend) => (
              <option key={friend.id} value={friend.id}>
                {friend.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Amount (dollars)</span>
          <input
            id="send-amount"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="25.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>

        <label className="field">
          <span>Note (optional)</span>
          <input
            id="send-note"
            maxLength={140}
            placeholder="Dinner last night"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        <label className="field">
          <span>Settlement behaviour (demo)</span>
          <select
            id="send-mode"
            value={simulate}
            onChange={(event) => setSimulate(event.target.value as SimulateMode)}
          >
            <option value="NONE">Normal</option>
            <option value="TRANSIENT">Transient fault - retries, then succeeds</option>
            <option value="PERMANENT">Permanent fault - retries, gives up, refunds</option>
          </select>
        </label>

        <p className="tiny muted" style={{ margin: '-6px 0 10px' }}>
          A transient fault is the common case in real systems: something breaks briefly.
          The saga retries with backoff and the payment still completes. Only a permanent
          fault exhausts the retries and gets the money returned.
        </p>

        <div
          id="send-error"
          className={`small${error ? '' : ' hidden'}`}
          style={{ color: 'var(--bad)', marginTop: 10 }}
        >
          {error}
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button type="button" id="send-cancel" className="grow" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary grow">
            Review
          </button>
        </div>
      </form>
    </Modal>
  );
}
