import { useMemo, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { StatusBadge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { fmt } from '../../lib/money';
import { ago } from '../../lib/time';
import type { ProjectedPayment } from '../../types/api';

interface Props {
  transactions: ProjectedPayment[];
  meId: string;
  nameOf: (id: string) => string;
  loading: boolean;
  onOpen: (paymentId: string) => void;
}

export function TransactionList({ transactions, meId, nameOf, loading, onOpen }: Props) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [direction, setDirection] = useState('');

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return transactions.filter((txn) => {
      const outgoing = txn.fromAccountId === meId;
      if (status && txn.status !== status) return false;
      if (direction === 'out' && !outgoing) return false;
      if (direction === 'in' && outgoing) return false;
      if (!term) return true;
      // Searchable by whatever a person actually remembers about a payment.
      return [
        nameOf(txn.fromAccountId),
        nameOf(txn.toAccountId),
        txn.note ?? '',
        (txn.amountCents / 100).toFixed(2),
        txn.status,
      ]
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  }, [transactions, meId, nameOf, search, status, direction]);

  return (
    <Card>
      <div className="card-head">
        <h2>Transactions</h2>
        <span className="tiny muted" id="txn-count">
          {`${visible.length} of ${transactions.length}`}
        </span>
      </div>

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <input
          id="search"
          className="grow"
          aria-label="Search transactions"
          placeholder="Search by name, note or amount…"
          style={{ minWidth: 180 }}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          id="filter-status"
          aria-label="Filter by status"
          style={{ width: 'auto' }}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All statuses</option>
          <option value="PROCESSING">Processing</option>
          <option value="COMPLETED">Completed</option>
          <option value="AWAITING_REFUND">Awaiting refund</option>
          <option value="REFUNDED">Refunded</option>
          <option value="FAILED">Failed</option>
        </select>
        <select
          id="filter-direction"
          aria-label="Filter by direction"
          style={{ width: 'auto' }}
          value={direction}
          onChange={(event) => setDirection(event.target.value)}
        >
          <option value="">Sent &amp; received</option>
          <option value="out">Sent</option>
          <option value="in">Received</option>
        </select>
      </div>

      <div id="transactions" className="list">
        {loading ? (
          <>
            <Skeleton />
            <Skeleton />
          </>
        ) : transactions.length === 0 ? (
          <EmptyState>
            No payments yet. Send one to a friend and watch it appear here.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState>Nothing matches that search.</EmptyState>
        ) : (
          visible.map((txn) => {
            const outgoing = txn.fromAccountId === meId;
            const other = outgoing ? txn.toAccountId : txn.fromAccountId;
            const open = () => onOpen(txn.paymentId);
            return (
              <div
                key={txn.paymentId}
                className="item"
                tabIndex={0}
                onClick={open}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    open();
                  }
                }}
              >
                <Avatar name={nameOf(other)} />
                <div className="grow stack">
                  <div className="row">
                    <span>{`${outgoing ? 'To' : 'From'} ${nameOf(other)}`}</span>
                    <StatusBadge status={txn.status} />
                  </div>
                  <div className="tiny muted truncate">
                    {[txn.note, ago(txn.updatedAt || txn.createdAt)]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <div className={`amount ${outgoing ? 'out' : 'in'}`}>
                  {`${outgoing ? '−' : '+'}${fmt(txn.amountCents)}`}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
