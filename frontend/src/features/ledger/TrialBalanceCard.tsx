import { Card, CardHead } from '../../components/Card';
import { fmt } from '../../lib/money';
import type { TrialBalance } from '../../types/api';

/**
 * The trial balance, stated as a verdict rather than a table of numbers to
 * squint at. Two columns must be equal; either they are or they are not.
 */
/**
 * The three ways the books can be wrong, in the order that matters.
 *
 * They are genuinely different faults and the difference is diagnostic: a
 * column mismatch means a journal was written with one side missing, while
 * equal columns with a drifted balance means the journal is fine and
 * something changed a balance without posting an entry for it. Reporting
 * either as "out of balance by $X" hides which one happened.
 */
function problemsIn(data: TrialBalance): string[] {
  const problems: string[] = [];

  if (!data.balanced) {
    problems.push(
      `Debits and credits differ by ${fmt(Math.abs(data.differenceCents))} — a journal entry is missing a side`,
    );
  }

  if (data.mismatchedAccounts > 0) {
    const drifted = data.rows.filter((row) => !row.matches);
    problems.push(
      drifted.length === 1
        ? `${drifted[0].accountName}'s balance disagrees with its own journal lines by ${fmt(
            Math.abs(drifted[0].cachedBalanceCents - drifted[0].ledgerBalanceCents),
          )}`
        : `${drifted.length} accounts disagree with their own journal lines`,
    );
  }

  if (!data.zeroSum) {
    problems.push(
      `All balances together come to ${fmt(data.systemTotalCents)} instead of zero — money was created or destroyed`,
    );
  }

  return problems;
}

export function TrialBalanceCard({ data }: { data: TrialBalance }) {
  const problems = problemsIn(data);
  const ok = problems.length === 0;

  return (
    <Card>
      <CardHead title="Trial balance" aside="read from the journal, not a cache" />

      <div id="tb-verdict" className={`verdict ${ok ? 'ok' : 'bad'}`}>
        <div className="mark">{ok ? '✓' : '!'}</div>
        <div>
          <div className="headline">
            {ok ? 'The books balance' : `The books do not balance: ${problems[0]}`}
          </div>
          <div className="tiny muted">
            {ok
              ? 'Every debit has an equal credit, all balances sum to zero, and every cached balance agrees with its own journal lines.'
              : problems.slice(1).join(' · ') ||
                'The journal itself is intact — the disagreement is with a balance held outside it.'}
          </div>
        </div>
      </div>

      <div className="columns">
        <div className="column">
          <div className="k">Total debits</div>
          <div className="v" id="tb-debits">
            {fmt(data.totalDebitsCents)}
          </div>
        </div>
        <div className="equals">{data.balanced ? '=' : '≠'}</div>
        <div className="column">
          <div className="k">Total credits</div>
          <div className="v" id="tb-credits">
            {fmt(data.totalCreditsCents)}
          </div>
        </div>
      </div>

      <div className="stats" style={{ marginTop: 10 }}>
        <div className="stat">
          <div className="k">Difference</div>
          <div className="v" id="tb-difference">
            {fmt(data.differenceCents)}
          </div>
        </div>
        <div className="stat">
          <div className="k">All balances sum to</div>
          <div className="v" id="tb-zerosum">
            {fmt(data.systemTotalCents)}
          </div>
        </div>
        <div className="stat">
          <div className="k">Accounts</div>
          <div className="v">{data.rows.length}</div>
        </div>
        <div className="stat">
          <div className="k">Cache mismatches</div>
          <div className="v" id="tb-mismatches">
            {data.mismatchedAccounts}
          </div>
        </div>
      </div>

      <p className="note">
        Opening a wallet is itself a journal entry — the funding account is debited
        for exactly what the wallet is credited. That is why the system is a closed
        set of books and every balance added together comes to zero.
      </p>
    </Card>
  );
}
