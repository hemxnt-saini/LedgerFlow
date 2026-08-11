import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { fmt } from '../../lib/money';
import type { AccountStatement } from '../../types/api';

/**
 * One account read down the page with a running balance.
 *
 * Opening plus every movement shown equals closing, always - which is what
 * makes a truncated window trustworthy rather than merely recent.
 */
export function StatementCard({
  data,
  onClose,
}: {
  data: AccountStatement;
  onClose: () => void;
}) {
  return (
    <Card>
      <div className="card-head">
        <h2>{`Statement · ${data.accountName}`}</h2>
        <button className="ghost small" id="statement-close" onClick={onClose}>
          Back to journal
        </button>
      </div>

      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat">
          <div className="k">Opening</div>
          <div className="v" id="st-opening">
            {fmt(data.openingCents)}
          </div>
        </div>
        <div className="stat">
          <div className="k">Movements</div>
          <div className="v">{data.lines.length}</div>
        </div>
        <div className="stat">
          <div className="k">Closing</div>
          <div className="v" id="st-closing">
            {fmt(data.closingCents)}
          </div>
        </div>
        <div className="stat">
          <div className="k">Matches cache</div>
          <div className="v" style={{ color: data.matches ? 'var(--good)' : 'var(--bad)' }}>
            {data.matches ? '✓' : '✕'}
          </div>
        </div>
      </div>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Leg</th>
              <th>Counterparty</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody id="statement">
            {data.lines.map((line, index) => (
              <tr key={`${line.entryGroup}-${index}`}>
                <td>{new Date(line.createdAt).toLocaleTimeString()}</td>
                <td>
                  <span className={`leg ${line.leg}`}>{line.leg}</span>
                </td>
                <td>{line.counterpartyName ?? '—'}</td>
                <td className="num">{line.direction === 'DEBIT' ? fmt(line.amountCents) : ''}</td>
                <td className="num">{line.direction === 'CREDIT' ? fmt(line.amountCents) : ''}</td>
                <td className="num">{fmt(line.runningCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.lines.length === 0 && (
        <div style={{ marginTop: 10 }}>
          <EmptyState>No journal lines for this account yet.</EmptyState>
        </div>
      )}

      <p className="tiny muted" style={{ marginTop: 10, marginBottom: 0 }}>
        Opening {fmt(data.openingCents)} plus every movement above comes to{' '}
        {fmt(data.closingCents)} — and that is the balance the API serves for this
        account.
      </p>
    </Card>
  );
}
