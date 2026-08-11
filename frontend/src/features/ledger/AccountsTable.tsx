import { Card, CardHead } from '../../components/Card';
import { fmt } from '../../lib/money';
import type { TrialBalance } from '../../types/api';

interface Props {
  data: TrialBalance;
  selectedId: string | null;
  onSelect: (accountId: string | null) => void;
}

/**
 * The trial balance line by line. Clicking an account opens its statement,
 * which is the only way to answer "why is this number what it is".
 */
export function AccountsTable({ data, selectedId, onSelect }: Props) {
  return (
    <Card>
      <CardHead
        title="Accounts"
        aside={selectedId ? 'click again to clear' : 'click one for its statement'}
      />
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Debits</th>
              <th className="num">Credits</th>
              <th className="num">Ledger</th>
              <th className="num">Cached</th>
              <th>OK</th>
            </tr>
          </thead>
          <tbody id="tb-accounts">
            {data.rows.map((row) => (
              <tr
                key={row.accountId}
                className={`selectable${row.accountId === selectedId ? ' on' : ''}`}
                onClick={() => onSelect(row.accountId === selectedId ? null : row.accountId)}
              >
                <td>
                  {row.accountName}
                  {row.isSystem && <span className="tiny muted"> · system</span>}
                </td>
                <td className="num">{fmt(row.debitsCents)}</td>
                <td className="num">{fmt(row.creditsCents)}</td>
                <td className="num">{fmt(row.ledgerBalanceCents)}</td>
                <td className="num">{fmt(row.cachedBalanceCents)}</td>
                <td style={{ color: row.matches ? 'var(--good)' : 'var(--bad)' }}>
                  {row.matches ? '✓' : '✕'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num">{fmt(data.totalDebitsCents)}</td>
              <td className="num">{fmt(data.totalCreditsCents)}</td>
              <td className="num">{fmt(data.systemTotalCents)}</td>
              <td className="num">{fmt(data.systemTotalCents)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="tiny muted" style={{ marginTop: 10, marginBottom: 0 }}>
        <strong>Ledger</strong> is recomputed from the journal every time this loads.
        <strong> Cached</strong> is the balance column the API serves. They are separate
        numbers on purpose — if they ever disagree, this table names the account.
      </p>
    </Card>
  );
}
