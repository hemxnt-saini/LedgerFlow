import { Card, CardHead } from '../../components/Card';

const HOPS = [
  ["POST /payments", "write"],
  ["Postgres commit + outbox row", "write"],
  ["poller publishes", ""],
  ["Kafka", ""],
  ["consumer projects", "read"],
  ["Redis read model", "read"],
  ["SSE to the browser", "read"],
] as const;

/**
 * What this thing is, before anyone clicks anything.
 *
 * The split is the whole design and it is invisible from the wallet: two
 * services that never call each other, joined only by a log.
 */
export function ArchitectureCard() {
  return (
    <Card>
      <CardHead title="How a payment travels" aside="two services, one log" />
      <div className="pipeline-map">
        {HOPS.map(([label, side], index) => (
          <span key={label}>
            <span className={`node ${side}`}>{label}</span>
            {index < HOPS.length - 1 && <span className="arrow"> → </span>}
          </span>
        ))}
      </div>
      <p className="tiny muted" style={{ marginTop: 12, marginBottom: 0 }}>
        The write side owns Postgres and answers commands. The read side owns a
        Redis projection and answers queries. They never call each other —
        everything the read side knows arrived over Kafka, which is why it can
        be deleted and rebuilt from the log. A payment is two transactions with
        a real gap between them, and the money sits in a clearing account in
        between, so the ledger balances even mid-flight.
      </p>
    </Card>
  );
}
