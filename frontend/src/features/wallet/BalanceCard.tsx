import { Card } from '../../components/Card';
import { fmt } from '../../lib/money';
import type { ProjectedPayment } from '../../types/api';

interface Props {
  balanceCents: number;
  inFlight: ProjectedPayment[];
  onSend: () => void;
}

export function BalanceCard({ balanceCents, inFlight, onSend }: Props) {
  const held = inFlight.reduce((total, txn) => total + txn.amountCents, 0);

  return (
    <Card className="balance-card">
      <div className="spread">
        <div>
          <div className="label">Wallet balance</div>
          <div id="balance" className="balance-amount">
            {fmt(balanceCents)}
          </div>
          {/* Money mid-saga is neither yours nor theirs - say where it is. */}
          <div id="pending" className="pending">
            {held ? `${fmt(held)} in flight - held in clearing until it settles` : ''}
          </div>
        </div>
        <button id="send-btn" className="primary" onClick={onSend}>
          ＋ Send money
        </button>
      </div>
    </Card>
  );
}
