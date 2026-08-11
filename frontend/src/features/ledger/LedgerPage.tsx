import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getJournal, getStatement, getTrialBalance } from '../../api/ledger';
import { Card } from '../../components/Card';
import { LiveDot } from '../../components/LiveDot';
import { Skeleton } from '../../components/Skeleton';
import { useEventStream } from '../../hooks/useEventStream';
import type { AccountStatement, JournalEntry, TrialBalance } from '../../types/api';
import { AccountsTable } from './AccountsTable';
import { JournalList } from './JournalList';
import { StatementCard } from './StatementCard';
import { TrialBalanceCard } from './TrialBalanceCard';
import './ledger.css';

/**
 * The books, and the proof that they are correct.
 *
 * Everything here is recomputed from `ledger_entries` on each load. There is
 * no summary table that could fall out of date and no cached figure that
 * could be wrong in a way the journal is not - which is the entire reason the
 * numbers on this page can be trusted over the ones on the wallet.
 */
export function LedgerPage() {
  const [balance, setBalance] = useState<TrialBalance | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [statement, setStatement] = useState<AccountStatement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (accountId: string | null) => {
    try {
      const [trial, entries] = await Promise.all([getTrialBalance(), getJournal(50, accountId)]);
      setBalance(trial);
      setJournal(entries.entries);
      setStatement(accountId ? await getStatement(accountId) : null);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load(selectedId);
  }, [load, selectedId]);

  // A payment posts journal entries, so the books change under this page.
  const { connected } = useEventStream({
    onEvent: useCallback(() => void load(selectedId), [load, selectedId]),
  });

  return (
    <div className="page-ledger">
      <header className="topbar">
        <div className="brand">
          <div className="logo">⚖</div>
          <div>
            <h1>Ledger</h1>
            <div className="tiny muted">
              <LiveDot connected={connected} /> · <Link to="/">wallet</Link> ·{' '}
              <Link to="/controls">controls</Link> · <Link to="/kafka">Kafka control room</Link>
            </div>
          </div>
        </div>
        <button className="ghost small" id="ledger-refresh" onClick={() => void load(selectedId)}>
          Refresh
        </button>
      </header>

      <main>
        {failed ? (
          <Card>
            <div className="empty">
              Cannot reach the payment service on :4000. The ledger is read from Postgres,
              so there is nothing to show without it.
            </div>
          </Card>
        ) : !balance ? (
          <Card>
            <Skeleton />
          </Card>
        ) : (
          <>
            {/* Verdict, then the per-account detail behind it, then the raw
                entries. Each is full width: these are all wide numeric tables
                and squeezing them into a sidebar only hides columns. */}
            <TrialBalanceCard data={balance} />
            <AccountsTable data={balance} selectedId={selectedId} onSelect={setSelectedId} />
            {statement ? (
              <StatementCard data={statement} onClose={() => setSelectedId(null)} />
            ) : (
              <JournalList entries={journal} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
