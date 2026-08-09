import { Card, CardHead } from '../../components/Card';
import { StatTile } from '../../components/StatTile';
import { fmt } from '../../lib/money';
import type { Stats } from '../../types/api';

/**
 * Every number here is a counter the projection maintains, not a scan - the
 * read side answers in O(1) because the write path already did the arithmetic.
 * Money only counts once it has actually arrived.
 */
export function StatsPanel({ stats, inFlightCount }: { stats: Stats | null; inFlightCount: number }) {
  const zero = { sentCents: 0, receivedCents: 0, sentCount: 0, receivedCount: 0 };
  const today = stats?.today ?? zero;
  const week = stats?.thisWeek ?? zero;
  const allTime = stats?.allTime ?? zero;

  return (
    <Card>
      <CardHead title="Payment statistics" aside="from the Redis read model" />
      <div className="stats">
        <StatTile id="stat-today-sent" label="Sent today" value={fmt(today.sentCents)} />
        <StatTile id="stat-today-recv" label="Received today" value={fmt(today.receivedCents)} />
        <StatTile id="stat-week-sent" label="Sent this week" value={fmt(week.sentCents)} />
        <StatTile id="stat-total-sent" label="Total sent" value={fmt(allTime.sentCents)} />
      </div>
      <div className="stats" style={{ marginTop: 10 }}>
        <StatTile id="stat-total-recv" label="Total received" value={fmt(allTime.receivedCents)} />
        <StatTile id="stat-count-sent" label="Payments sent" value={String(allTime.sentCount)} />
        <StatTile id="stat-count-recv" label="Payments received" value={String(allTime.receivedCount)} />
        <StatTile id="stat-inflight" label="In flight" value={String(inFlightCount)} />
      </div>
    </Card>
  );
}
