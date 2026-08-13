import { Link } from 'react-router-dom';
import { Card, CardHead } from '../../components/Card';
import { fmt } from '../../lib/money';
import { ago } from '../../lib/time';
import type { SystemStatus } from './useSystemStatus';
import './overview.css';

type Tone = 'good' | 'warn' | 'bad' | 'idle';

function Tile({
  id,
  label,
  value,
  detail,
  tone = 'idle',
  to,
  loading = false,
}: {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone?: Tone;
  to?: string;
  loading?: boolean;
}) {
  /**
   * An ellipsis next to a confident-looking detail line reads as data. While
   * the first poll is outstanding the tiles showed "…" above "0 messages in
   * the log", which is indistinguishable from a healthy, genuinely-zero
   * system. A shimmer says "not yet", which is what is true.
   */
  const body = loading ? (
    <>
      <div className="k">{label}</div>
      <div className="tile-ghost v-ghost" />
      <div className="tile-ghost d-ghost" />
      <span className="sr-only" id={id}>
        Loading
      </span>
    </>
  ) : (
    <>
      <div className="k">{label}</div>
      <div className="v" id={id}>
        {value}
      </div>
      <div className="d">{detail}</div>
    </>
  );
  return to ? (
    <Link className={`tile ${tone}`} to={to}>
      {body}
    </Link>
  ) : (
    <div className={`tile ${tone}`}>{body}</div>
  );
}

const yesNo = (up: boolean | null) => (up === null ? "…" : up ? "Up" : "Down");
const upTone = (up: boolean | null): Tone =>
  up === null ? "idle" : up ? "good" : "bad";

/**
 * The system, in one screen.
 *
 * This is the first thing anyone sees, and what it has to establish is that
 * this is payments infrastructure rather than a form for moving numbers
 * between names. Every figure here is read live from the thing it describes -
 * the broker for lag, the journal for the books, the control's own history
 * for its last verdict.
 */
export function SystemPanel({ status }: { status: SystemStatus }) {
  const { books, kafka, recon } = status;
  // Everything is set in one write, so one null means the first poll has not
  // returned yet rather than that this particular figure is missing.
  const loading = status.writeUp === null;
  const mainTopic = kafka?.topics.find(
    (topic) => topic.topic === kafka.mainTopic,
  );
  const dlqTopic = kafka?.topics.find(
    (topic) => topic.topic === kafka.dlqTopic,
  );
  const lag = mainTopic?.lag ?? null;
  const parked = dlqTopic?.messages ?? null;

  const booksTone: Tone =
    books === null
      ? "idle"
      : books.balanced && books.zeroSum && books.mismatchedAccounts === 0
        ? "good"
        : "bad";
  const reconTone: Tone =
    recon === null
      ? "idle"
      : recon.status === "OK"
        ? "good"
        : recon.status === "WARN"
          ? "warn"
          : "bad";

  return (
    <Card>
      <CardHead title="System status" aside="live, every 5 seconds" />
      <div className="tiles" id="system-tiles">
        <Tile
          id="sys-write"
          label="Payment service"
          value={yesNo(status.writeUp)}
          detail="Commands · Postgres · :4000"
          tone={upTone(status.writeUp)}
          loading={loading}
        />
        <Tile
          id="sys-read"
          label="Query service"
          value={yesNo(status.readUp)}
          detail="Queries · Redis · :4001"
          tone={upTone(status.readUp)}
          loading={loading}
        />
        <Tile
          id="sys-books"
          label="The books"
          value={
            books === null ? "…" : booksTone === "good" ? "Balanced" : "Out"
          }
          detail={
            books === null
              ? "Reading the journal"
              : `${fmt(books.totalDebitsCents)} debits = credits`
          }
          tone={booksTone}
          loading={loading}
          to="/ledger"
        />
        <Tile
          id="sys-control"
          label="Last control run"
          value={recon === null ? "…" : recon.status}
          detail={
            recon === null
              ? "No run recorded"
              : `${ago(recon.startedAt)} · run #${recon.id}`
          }
          tone={reconTone}
          loading={loading}
          to="/controls"
        />
        <Tile
          id="sys-clearing"
          label="Money in flight"
          value={
            status.clearingCents === null ? "…" : fmt(status.clearingCents)
          }
          detail="Held in the clearing account"
          tone={status.clearingCents ? "warn" : "idle"}
          to="/pipeline"
          loading={loading}
        />
        <Tile
          id="sys-reviews"
          label="Awaiting review"
          value={status.reviewCount === null ? "…" : String(status.reviewCount)}
          detail="Payments held for a decision"
          tone={status.reviewCount ? "warn" : "idle"}
          to="/ops"
          loading={loading}
        />
        <Tile
          id="sys-lag"
          label="Consumer lag"
          value={lag === null ? "…" : String(lag)}
          detail={
            kafka?.consumerPaused
              ? "Consumer is paused"
              : `${mainTopic?.messages ?? 0} messages in the log`
          }
          tone={kafka?.consumerPaused ? "warn" : lag ? "warn" : "good"}
          to="/kafka"
          loading={loading}
        />
        <Tile
          id="sys-dlq"
          label="Parked messages"
          value={parked === null ? "…" : String(parked)}
          detail="Dead letter queue"
          tone={parked ? "warn" : "idle"}
          to="/kafka"
          loading={loading}
        />
      </div>
    </Card>
  );
}
