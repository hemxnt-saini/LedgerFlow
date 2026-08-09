import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import type { DeadLetter } from '../../types/api';

interface Props {
  /** null means the read side could not be reached. */
  entries: DeadLetter[] | null;
  onReplay: (entry: DeadLetter) => Promise<void>;
}

export function DlqList({ entries, onReplay }: Props) {
  const [replaying, setReplaying] = useState<string | null>(null);

  if (entries === null) {
    return (
      <div id="dlq" className="list">
        <EmptyState>Could not reach the read side.</EmptyState>
      </div>
    );
  }

  return (
    <div id="dlq" className="list">
      {entries.length === 0 ? (
        <EmptyState>Nothing parked. Good.</EmptyState>
      ) : (
        entries.map((entry) => (
          <div className="item flat" key={entry.dlqId}>
            <div className="grow stack">
              <div className="small">{entry.reason + (entry.replayedAt ? ' · replayed' : '')}</div>
              <div className="tiny muted truncate">
                {`${entry.sourceTopic}-${entry.partition}@${entry.offset} · ${entry.detail}`}
              </div>
            </div>
            <button
              className="tiny"
              disabled={replaying === entry.dlqId}
              onClick={async () => {
                setReplaying(entry.dlqId);
                await onReplay(entry);
              }}
            >
              Replay
            </button>
          </div>
        ))
      )}
    </div>
  );
}
