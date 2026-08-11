import { useCallback, useEffect, useState } from 'react';
import { listAccounts } from '../../api/accounts';
import { getPipelineTraces } from '../../api/read-model';
import { PageShell } from '../../components/PageShell';
import { Card, CardHead } from '../../components/Card';
import { useEventStream } from '../../hooks/useEventStream';
import { CLEARING_ACCOUNT_ID } from '../../lib/config';
import { fmt, median, ms, percentile } from '../../lib/money';
import type { ActivityEntry, PipelineTrace, StreamEvent } from '../../types/api';
import './pipeline.css';

const MAX_TRACES = 200;
const SAMPLE = 50;

const STAGES = [
  ['s-outbox', 'outboxMs', 'Commit → published', 'Outbox poller pickup. Bounded by its poll interval.'],
  ['s-transport', 'transportMs', 'Published → received', 'Kafka produce, store and fetch.'],
  ['s-projection', 'projectionMs', 'Received → projected', 'Writing the Redis read model.'],
  ['s-total', 'totalMs', 'End to end', 'Write commits until the read side can answer.'],
] as const;

/**
 * The pipeline, measured rather than described.
 *
 * Each timestamp is stamped at a real hop: the write side on commit, the
 * publisher when the event actually reached Kafka, the consumer on arrival and
 * again once the read model reflects it.
 */
export function PipelinePage() {
  const [traces, setTraces] = useState<PipelineTrace[]>([]);
  const [events, setEvents] = useState<Map<string, ActivityEntry>>(new Map());
  const [selected, setSelected] = useState<PipelineTrace | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string>('$0.00');

  const refreshClearing = useCallback(async () => {
    try {
      const accounts = await listAccounts(true);
      const account = accounts.find((item) => item.id === CLEARING_ACCOUNT_ID);
      setClearing(fmt(account?.balanceCents ?? 0));
    } catch {
      setClearing('–');
    }
  }, []);

  useEffect(() => {
    getPipelineTraces(MAX_TRACES)
      .then((result) => setTraces(result.traces))
      // The read side may not be up yet; the live stream will fill in.
      .catch(() => undefined);
    void refreshClearing();
  }, [refreshClearing]);

  const { connected } = useEventStream({
    onEvent: useCallback(
      ({ event, trace }: StreamEvent) => {
        setEvents((current) => new Map(current).set(trace.eventId, event));
        setTraces((current) => [trace, ...current].slice(0, MAX_TRACES));
        setFreshId(trace.eventId);
        void refreshClearing();
      },
      [refreshClearing],
    ),
  });

  const sample = traces.slice(0, SAMPLE);
  return (
    <div className="page-pipeline">
      <PageShell
        logo="▤"
        title="Event monitor"
        connected={connected}
        actions={<button
            id="clear"
            className="ghost small"
            onClick={() => {
              setTraces([]);
              setEvents(new Map());
              setSelected(null);
            }}
          >
            Clear
          </button>}
      >
        <Card>
          <CardHead title="What you are looking at" />
          <p className="small muted" style={{ marginTop: -4 }}>
            Every row below is a real event that travelled the whole pipeline. The timings
            are measured, not simulated: the write side stamps the commit, the outbox
            publisher stamps the moment it actually reached Kafka, and the query service
            stamps arrival and projection. The gap between the first and last column is
            exactly the eventual-consistency window the wallet warns about.
          </p>
          <div className="lifecycle" style={{ marginTop: 12 }}>
            {[
              'POST /payments',
              'validate',
              'Postgres commit + outbox row',
              'poller publishes to Kafka',
              'consumer projects to Redis',
              'SSE to this page',
            ].map((node, index, all) => (
              <span key={node}>
                <span className="node">{node}</span>
                {index < all.length - 1 && <span className="arrow"> → </span>}
              </span>
            ))}
          </div>
        </Card>

        <Card>
          <div className="card-head">
            <h2>Stage latency</h2>
            <span className="tiny muted" id="sample-size">
              {sample.length ? `median of last ${sample.length}` : ''}
            </span>
          </div>
          <div className="flow">
            {STAGES.map(([id, key, title, detail]) => {
              const value = median(sample.map((trace) => trace.stages[key]));
              return (
                <div className="stage" key={id}>
                  <div className="n">{title}</div>
                  <div className="t" id={id}>
                    {value === null ? '–' : ms(value)}
                  </div>
                  <div className="d">{detail}</div>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="grid">
          <div>
            <Card>
              <div className="card-head">
                <h2>Live events</h2>
                <span className="tiny muted" id="event-count">{`${traces.length} events`}</span>
              </div>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>Payment</th>
                      <th className="num">Outbox</th>
                      <th className="num">Transport</th>
                      <th className="num">Project</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody id="events">
                    {traces.map((trace) => (
                      <tr
                        key={trace.eventId}
                        className={trace.eventId === freshId ? 'fresh' : undefined}
                        onClick={() => setSelected(trace)}
                      >
                        <td>{new Date(trace.projectedAt).toLocaleTimeString()}</td>
                        <td className="mono">{trace.type}</td>
                        <td>{trace.paymentId ? `${trace.paymentId.slice(0, 8)}…` : '—'}</td>
                        <td className="num">{ms(trace.stages.outboxMs)}</td>
                        <td className="num">{ms(trace.stages.transportMs)}</td>
                        <td className="num">{ms(trace.stages.projectionMs)}</td>
                        <td className="num">{ms(trace.stages.totalMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div
                id="events-empty"
                className={`empty${traces.length > 0 ? ' hidden' : ''}`}
                style={{ marginTop: 10 }}
              >
                Waiting for events. Send a payment in the wallet and watch them arrive.
              </div>
            </Card>
          </div>

          <div>
            <Card>
              <CardHead title="Money in flight" />
              <div className="stat" style={{ marginBottom: 10 }}>
                <div className="k">Clearing account</div>
                <div className="v" id="clearing">
                  {clearing}
                </div>
              </div>
              <p className="tiny muted" style={{ margin: 0 }}>
                A payment is two transactions, not one. Between them the money is neither
                the sender's nor the receiver's - it belongs to the clearing account. That
                is why the ledger still balances mid-saga, and why stranded money can
                always be found and returned.
              </p>
            </Card>

            <Card>
              <CardHead title="End to end" aside={`last ${sample.length}`} />
              <div className="stats">
                {(
                  [
                    ['p50', 50],
                    ['p95', 95],
                    ['p99', 99],
                    ['max', 100],
                  ] as const
                ).map(([label, p]) => {
                  const value = percentile(
                    sample.map((trace) => trace.stages.totalMs),
                    p,
                  );
                  return (
                    <div className="stat" key={label}>
                      <div className="k">{label}</div>
                      <div className="v" id={`pct-${label}`}>
                        {value === null ? '–' : ms(value)}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="tiny muted" style={{ marginTop: 10, marginBottom: 0 }}>
                A median hides the tail, and the tail is what a latency promise is
                written against. p95 is the number that decides whether a system feels
                fast; p50 only says the common case was fine.
              </p>
            </Card>

            <Card>
              <CardHead title="Selected event" />
              <div id="detail" className="tiny muted">
                {selected ? (
                  <pre>
                    {JSON.stringify(
                      {
                        event: events.get(selected.eventId) ?? '(loaded from history)',
                        trace: selected,
                      },
                      null,
                      2,
                    )}
                  </pre>
                ) : (
                  'Click a row to inspect its payload and timings.'
                )}
              </div>
            </Card>
          </div>
        </div>
      </PageShell>
    </div>
  );
}
