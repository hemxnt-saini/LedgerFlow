import { Card, CardHead } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { activityLine } from '../../lib/labels';
import { fmt } from '../../lib/money';
import { ago } from '../../lib/time';
import type { ActivityEntry } from '../../types/api';

interface Props {
  activity: ActivityEntry[];
  nameOf: (id: string) => string;
}

export function ActivityFeed({ activity, nameOf }: Props) {
  return (
    <Card>
      <CardHead title="Live activity" aside="everyone" />
      <p className="tiny muted" style={{ margin: '-4px 0 10px' }}>
        Pushed over SSE from the query service as events land. A payment takes about a
        second to appear - that gap is the CQRS read model catching up, not a bug.
      </p>
      <div id="activity" className="list feed">
        {activity.length === 0 ? (
          <EmptyState>Nothing has happened yet.</EmptyState>
        ) : (
          activity.slice(0, 40).map((entry) => (
            <div className="item flat" key={entry.eventId}>
              <div className="grow stack">
                <div>{activityLine(entry, nameOf, fmt(entry.amountCents))}</div>
                <div className="tiny muted">{ago(entry.occurredAt)}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
