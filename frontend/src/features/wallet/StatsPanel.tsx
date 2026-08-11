import { Card, CardHead } from '../../components/Card';
import { StatTile } from '../../components/StatTile';
import { fmt } from '../../lib/money';
import type { Stats } from '../../types/api';

/**
 * Four numbers, not eight.
 *
 * This panel used to carry today, this week and all time for both directions
 * plus two counts - which is a lot of tiles saying very little. "Payments
 * sent: 3" next to "Total sent: $12.50" adds nothing, and nobody has ever
 * needed "sent this week" on a wallet dashboard. What is left is the pair a
 * person actually looks for, the running total, and the one figure that is
 * not a total at all: money currently in flight.
 *
 * Every value is a counter the projection maintains, not a scan - the read
 * side answers in O(1) because the write path already did the arithmetic.
 * Money only counts once it has actually arrived.
 */
export function StatsPanel({
  stats,
  inFlightCount,
}: {
  stats: Stats | null;
  inFlightCount: number;
}) {
  const zero = { sentCents: 0, receivedCents: 0, sentCount: 0, receivedCount: 0 };
  const today = stats?.today ?? zero;
  const allTime = stats?.allTime ?? zero;

  return (
    <Card>
      <CardHead title="Payment statistics" aside="from the Redis read model" />
      <div className="stats">
        <StatTile id="stat-today-sent" label="Sent today" value={fmt(today.sentCents)} />
        <StatTile
          id="stat-today-recv"
          label="Received today"
          value={fmt(today.receivedCents)}
        />
        <StatTile id="stat-total-sent" label="Total sent" value={fmt(allTime.sentCents)} />
        <StatTile id="stat-inflight" label="In flight" value={String(inFlightCount)} />
      </div>
    </Card>
  );
}
