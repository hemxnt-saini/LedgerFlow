import type { PartitionView } from '../../types/api';

/**
 * One partition, drawn as what it is: an append-only line with a read cursor.
 * Green is behind the cursor, amber is the backlog ahead of it.
 */
export function PartitionBar({ topic, partition }: { topic: string; partition: PartitionView }) {
  const total = Math.max(partition.high - partition.low, 0);
  const position = partition.committed === null ? partition.low : partition.committed;
  const readCount = Math.max(position - partition.low, 0);

  return (
    <div className="partition">
      <div className="partition-head">
        <span className={`pill p${partition.partition % 3}`}>
          {`${topic}-${partition.partition}`}
        </span>
        <span className="tiny muted">
          {`offsets ${partition.low}–${partition.high}` +
            (partition.committed === null
              ? ' · never committed'
              : ` · read to ${partition.committed}`) +
            (partition.lag > 0 ? ` · ${partition.lag} behind` : '')}
        </span>
      </div>

      <div className="logbar">
        {total > 0 && (
          <>
            <div className="read" style={{ width: `${(readCount / total) * 100}%` }} />
            <div className="unread" style={{ width: `${(partition.lag / total) * 100}%` }} />
            <div className="ticks">
              {Array.from({ length: Math.min(total, 40) }, (_, index) => (
                <div className="tick" key={index} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
