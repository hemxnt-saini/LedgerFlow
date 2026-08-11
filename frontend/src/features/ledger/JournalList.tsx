import { Card, CardHead } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { fmt } from '../../lib/money';
import type { JournalEntry } from '../../types/api';

/**
 * The general journal. Each entry is shown as the pair it is - one debit, one
 * credit - rather than as a flat list of lines, because half a journal entry
 * is not a meaningful thing to read.
 */
export function JournalList({ entries }: { entries: JournalEntry[] }) {
  return (
    <Card>
      <CardHead title="General journal" aside={`${entries.length} entries`} />
      <div id="journal" className="journal-grid">
        {entries.length === 0 ? (
          <EmptyState>Nothing posted yet. Send a payment and it appears here.</EmptyState>
        ) : (
          entries.map((entry) => (
            <div
              className={`entry${entry.balanced ? '' : ' broken'}`}
              key={entry.entryGroup}
            >
              <div className="entry-head">
                <span className={`leg ${entry.leg}`}>{entry.leg}</span>
                <span className="tiny muted">
                  {new Date(entry.createdAt).toLocaleTimeString()}
                  {entry.paymentId && ` · payment ${entry.paymentId.slice(0, 8)}…`}
                  {!entry.balanced && ' · UNBALANCED'}
                </span>
              </div>
              <div className="entry-lines">
                {entry.lines.map((line, index) => (
                  <div className="line" key={`${line.accountId}-${line.direction}-${index}`}>
                    <span className={`dir ${line.direction}`}>{line.direction}</span>
                    <span>{line.accountName}</span>
                    <span>{fmt(line.amountCents)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <p className="tiny muted" style={{ marginTop: 10, marginBottom: 0 }}>
        Append-only. A refund is not an edit — it posts a new COMPENSATE pair in the
        opposite direction, so the original AUTHORISE stays exactly where it was.
      </p>
    </Card>
  );
}
