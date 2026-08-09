import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { listAccounts } from '../../api/accounts';
import { listDeadLetters, replayDeadLetter } from '../../api/dlq';
import { getOverview, pauseConsumer, rebuildReadModel, resumeConsumer } from '../../api/kafka';
import { sendPayment } from '../../api/payments';
import { Card, CardHead } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { LiveDot } from '../../components/LiveDot';
import { useEventStream } from '../../hooks/useEventStream';
import { useInterval } from '../../hooks/useInterval';
import { useToasts } from '../../hooks/useToasts';
import type { DeadLetter, KafkaOverview, StreamEvent, TopicView } from '../../types/api';
import { DlqList } from './DlqList';
import { PartitionBar } from './PartitionBar';
import './kafka.css';

const MAX_MESSAGES = 150;

interface Message {
  id: string;
  time: string;
  partition: number;
  type: string;
  key: string;
  lagWas: number;
}

const mainTopicOf = (overview: KafkaOverview | null): TopicView | undefined =>
  overview?.topics.find((topic) => topic.topic === overview.mainTopic);

/**
 * The Kafka control room.
 *
 * Everything on this page is read from the broker's own admin protocol -
 * partitions, log start and end offsets, each group's committed position.
 * Nothing here is inferred from what the app happens to have seen.
 */
export function KafkaPage() {
  const { toast } = useToasts();
  const [overview, setOverview] = useState<KafkaOverview | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[] | null>(null);
  const [controlOut, setControlOut] = useState<string | null>(null);
  const [apiDown, setApiDown] = useState(false);

  // The lag as of the last poll, stamped onto each arriving message. Kept in a
  // ref because the stream handler must read it without re-subscribing.
  const lastLag = useRef(0);
  const freshId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getOverview();
      lastLag.current = mainTopicOf(next)?.lag ?? 0;
      setOverview(next);
      setApiDown(false);
    } catch {
      setApiDown(true);
    }
  }, []);

  const refreshDlq = useCallback(async () => {
    try {
      const { entries } = await listDeadLetters(10);
      setDeadLetters(entries);
    } catch {
      setDeadLetters(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshDlq();
  }, [refresh, refreshDlq]);

  const { connected } = useEventStream({
    onEvent: useCallback(
      ({ event, trace }: StreamEvent) => {
        const partition = trace.partition ?? 0;
        freshId.current = trace.eventId;
        setMessages((current) =>
          [
            {
              id: trace.eventId,
              time: new Date(trace.projectedAt).toLocaleTimeString(),
              partition,
              type: event.type,
              key: (event.paymentId ?? event.accountId ?? '—').slice(0, 8),
              lagWas: lastLag.current,
            },
            ...current,
          ].slice(0, MAX_MESSAGES),
        );
        void refresh();
      },
      [refresh],
    ),
    onDeadLetter: useCallback(() => {
      toast('A message was parked in the DLQ.', 'warn');
      void refreshDlq();
    }, [refreshDlq, toast]),
  });

  // Lag only changes when the broker moves, and while paused nothing arrives on
  // the stream to trigger a redraw - so poll slowly as well.
  useInterval(() => void refresh(), 2_000);

  const topic = mainTopicOf(overview);
  const dlqTopic = overview?.topics.find((item) => item.topic === overview.dlqTopic);
  const paused = overview?.consumerPaused ?? false;
  const groups = overview?.groups ?? [];

  async function onPause() {
    await pauseConsumer();
    toast('Consumer paused. Send payments and watch lag build.', 'warn');
    await refresh();
  }

  async function onResume() {
    await resumeConsumer();
    toast('Consumer resumed. The backlog is draining.', 'good');
    await refresh();
  }

  async function onRebuild() {
    setControlOut('Deleting the read model and rewinding to offset 0…');
    const result = await rebuildReadModel();
    setControlOut(JSON.stringify(result, null, 2));
    toast('Read model wiped. Rebuilding from the log.', 'warn');
  }

  async function onBurst() {
    const accounts = await listAccounts();
    if (accounts.length < 2) {
      toast('Run scripts/seed.sh first.', 'warn');
      return;
    }
    for (let i = 0; i < 5; i++) {
      await sendPayment({
        fromAccountId: accounts[0].id,
        toAccountId: accounts[1 + (i % (accounts.length - 1))].id,
        amountCents: 100 + i,
        note: 'burst',
      });
    }
    toast('Sent 5 payments.', 'good');
    await refresh();
  }

  return (
    <div className="page-kafka">
      <header className="topbar">
        <div className="brand">
          <div className="logo">≡</div>
          <div>
            <h1>Kafka control room</h1>
            <div className="tiny muted">
              <LiveDot connected={connected && !apiDown} /> · <Link to="/">wallet</Link> ·{' '}
              <Link to="/pipeline">pipeline latency</Link>
            </div>
          </div>
        </div>
        <div className="row">
          <span
            id="paused-pill"
            className={`badge AWAITING_REFUND${paused ? '' : ' hidden'}`}
          >
            CONSUMER PAUSED
          </span>
        </div>
      </header>

      <main>
        <div id="paused-banner" className={`banner${paused ? '' : ' hidden'}`}>
          The consumer is paused. Keep sending payments in the wallet - the write side
          carries on, the log keeps growing, and lag builds up below. Nothing is lost;
          resume and it drains.
        </div>

        <Card>
          <CardHead title="The log" aside={<span id="topic-name">{topic?.topic ?? ''}</span>} />
          <p className="small muted" style={{ marginTop: -4 }}>
            Kafka is not a queue that forgets. It is an append-only log the consumer walks
            along at its own pace, and everything below is read from the broker's own
            admin protocol - partitions, log start and end offsets, each group's committed
            position. <strong>Lag is the distance between the end of the log and where a
            reader has got to.</strong>
          </p>
          <div className="stats" style={{ marginTop: 12 }}>
            <div className="stat">
              <div className="k">Messages in log</div>
              <div className="v" id="k-messages">
                {topic ? String(topic.messages) : '–'}
              </div>
            </div>
            <div className="stat">
              <div className="k">Partitions</div>
              <div className="v" id="k-partitions">
                {topic ? String(topic.partitions.length) : '–'}
              </div>
            </div>
            <div className="stat">
              <div className="k">Consumer lag</div>
              <div className="v" id="k-lag">
                {topic ? String(topic.lag) : '–'}
              </div>
            </div>
            <div className="stat">
              <div className="k">Parked (DLQ)</div>
              <div className="v" id="k-dlq">
                {topic ? String(dlqTopic?.messages ?? 0) : '–'}
              </div>
            </div>
          </div>
        </Card>

        <div className="grid">
          <div>
            <Card>
              <CardHead title="Partitions" aside="read vs unread" />
              <div id="partitions" className="partitions">
                {topic?.partitions.map((partition) => (
                  <PartitionBar
                    key={partition.partition}
                    topic={topic.topic}
                    partition={partition}
                  />
                ))}
              </div>
              <div className="legend">
                <span>
                  <span className="swatch" style={{ background: 'var(--good)' }} />
                  consumed
                </span>
                <span>
                  <span className="swatch" style={{ background: 'var(--warn)' }} />
                  lagging behind
                </span>
                <span>
                  <span className="swatch" style={{ background: 'var(--border)' }} />
                  empty
                </span>
              </div>
              <p className="tiny muted" style={{ marginTop: 10 }}>
                Messages are keyed by payment id, so every event for one payment lands on
                the same partition and stays in order. Different payments spread across
                partitions and can be processed in parallel - ordering where it matters,
                throughput where it does not.
              </p>
            </Card>

            <Card>
              <CardHead
                title="Live messages"
                aside={
                  <span id="msg-count">
                    {messages.length === 0 ? '0' : `${messages.length} messages`}
                  </span>
                }
              />
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Partition</th>
                      <th>Event</th>
                      <th>Key</th>
                      <th className="num">Lag was</th>
                    </tr>
                  </thead>
                  <tbody id="messages">
                    {messages.map((message) => (
                      <tr
                        key={message.id}
                        className={message.id === freshId.current ? 'fresh' : undefined}
                      >
                        <td>{message.time}</td>
                        <td>
                          <span className={`pill p${message.partition % 3}`}>
                            {`p${message.partition}`}
                          </span>
                        </td>
                        <td className="mono">{message.type}</td>
                        <td>{message.key}</td>
                        <td className="num">{message.lagWas}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div
                id="messages-empty"
                className={`empty${messages.length > 0 ? ' hidden' : ''}`}
                style={{ marginTop: 10 }}
              >
                Nothing yet. Send a payment in the wallet.
              </div>
            </Card>
          </div>

          <div>
            <Card>
              <CardHead title="Try it" />
              <div className="controls">
                <button id="pause" className={`danger${paused ? ' hidden' : ''}`} onClick={onPause}>
                  Pause consumer
                </button>
                <button
                  id="resume"
                  className={`primary${paused ? '' : ' hidden'}`}
                  onClick={onResume}
                >
                  Resume consumer
                </button>
                <button id="burst" onClick={onBurst}>
                  Send 5 payments
                </button>
                <button id="rebuild" onClick={onRebuild}>
                  Rebuild read model
                </button>
              </div>
              <p className="tiny muted" style={{ marginTop: 10 }}>
                <strong>Pause, then send a burst.</strong> The wallet keeps working and the
                balances on the write side move immediately - but the read model freezes
                and lag climbs. Resume and it catches up on its own. That gap is the whole
                argument for putting a log between two services.
              </p>
              <p className="tiny muted">
                <strong>Rebuild</strong> deletes the entire read model and rewinds every
                partition to offset zero. It comes back identical, because the log is the
                source of truth and Redis is only a cache of it.
              </p>
              <pre id="control-out" className={controlOut === null ? 'hidden' : undefined}>
                {controlOut}
              </pre>
            </Card>

            <Card>
              <CardHead title="Consumer groups" />
              <div id="groups" className="list">
                {groups.length === 0 ? (
                  <EmptyState>No consumer groups yet.</EmptyState>
                ) : (
                  groups.map((group) => (
                    <div className="item flat" key={group.groupId}>
                      <div className="grow stack">
                        <div className="small mono">{group.groupId}</div>
                        <div className="tiny muted">
                          {`${group.state} · ${group.members.length} member(s)` +
                            (group.members[0]?.assignment.length
                              ? ` · owns ${group.members[0].assignment.join(', ')}`
                              : '')}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <p className="tiny muted" style={{ marginTop: 10 }}>
                Two independent groups read the same broker: one projects payments into the
                read model, one watches the parking topic. Each keeps its own offsets, so
                neither can affect the other's progress.
              </p>
            </Card>

            <Card>
              <CardHead title="Parked messages" aside="dead letter queue" />
              <DlqList
                entries={deadLetters}
                onReplay={async (entry) => {
                  await replayDeadLetter(entry.dlqId);
                  toast('Replayed onto the main topic.', 'good');
                  setTimeout(() => void refreshDlq(), 1500);
                }}
              />
              <p className="tiny muted" style={{ marginTop: 10 }}>
                A message we cannot process is republished to a parking topic instead of
                being dropped. Replay puts it back on the main topic; because every event
                carries an id the read model has already claimed, replaying something that
                did work changes nothing.
              </p>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
