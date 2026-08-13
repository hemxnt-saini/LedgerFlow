import { useCallback, useEffect, useState } from 'react';
import {
  getReconciliation,
  injectDrift,
  repairBalances,
  runReconciliation,
} from '../../api/reconciliation';
import { PageShell } from '../../components/PageShell';
import { Card, CardHead } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { useInterval } from '../../hooks/useInterval';
import { useToasts } from '../../hooks/useToasts';
import { fmt } from '../../lib/money';
import { ago } from '../../lib/time';
import type { ReconciliationRun } from '../../types/api';
import { ChecksList } from './ChecksList';
import { evaluate } from './checks';
import './controls.css';

const MARK = { OK: '✓', WARN: '!', DRIFT: '✕' } as const;

const HEADLINE = {
  OK: 'The books are intact',
  WARN: 'Behind, but not wrong',
  DRIFT: 'The books do not agree with themselves',
} as const;

const SUBLINE = {
  OK: 'Every check passed on the last pass.',
  WARN: 'A store is lagging with work still in flight. That is eventual consistency, not a fault.',
  DRIFT: 'Something changed money without going through the ledger. The findings below say what.',
} as const;

/**
 * The reconciliation control, made visible.
 *
 * A control nobody can see is a control nobody trusts. The worker has been
 * running on a schedule and writing verdicts to a table this whole time; this
 * page is where you read them, run one on demand, and - because a green light
 * that has never been red proves very little - break the books on purpose and
 * watch it catch that.
 */
export function ControlsPage() {
  const { toast } = useToasts();
  const [latest, setLatest] = useState<ReconciliationRun | null>(null);
  const [history, setHistory] = useState<ReconciliationRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await getReconciliation(30);
      setLatest(result.latest);
      setHistory(result.history);
    } catch {
      setLatest(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The worker runs on its own schedule, so new verdicts appear without us.
  useInterval(() => void load(), 5_000);

  async function withBusy(label: string, work: () => Promise<void>) {
    setBusy(label);
    try {
      await work();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work', 'bad');
    } finally {
      setBusy(null);
      await load();
    }
  }

  const runNow = () =>
    withBusy('run', async () => {
      const result = await runReconciliation();
      setOutput(JSON.stringify(result, null, 2));
      toast(
        result.status === 'OK'
          ? 'Control passed. The books are intact.'
          : `Control found ${result.findings.length} finding(s).`,
        result.status === 'OK' ? 'good' : 'bad',
      );
    });

  const breakBooks = () =>
    withBusy('drift', async () => {
      const result = await injectDrift(5_000);
      setOutput(
        `Moved ${fmt(result.driftCents)} onto ${result.accountName}'s balance without a journal entry.\n` +
          `Nothing errored. The API is fine, the wallet is fine.\n` +
          `Run the control - or wait for the scheduled pass - and watch it get caught.`,
      );
      toast(`Broke ${result.accountName}'s balance on purpose.`, 'warn');
    });

  const repair = () =>
    withBusy('repair', async () => {
      const result = await repairBalances();
      setOutput(
        result.repaired.length === 0
          ? 'Nothing to repair - every cached balance already matches the journal.'
          : result.repaired
              .map(
                (row) =>
                  `${row.accountName}: ${fmt(row.fromCents)} → ${fmt(row.toCents)} (recomputed from the journal)`,
              )
              .join('\n'),
      );
      toast(
        result.repaired.length === 0
          ? 'Nothing needed repairing.'
          : `Repaired ${result.repaired.length} balance(s), ${fmt(result.correctedCents)} corrected.`,
        'good',
      );
    });

  const status = latest?.status ?? 'OK';
  const maxDrift = Math.max(1, ...history.map((run) => Math.abs(run.driftCents)));

  // The report's driftCents sums every finding, and one corruption trips
  // several checks - so a $50 edit adds up to $150. The largest single
  // disagreement is the honest headline: that is the money unaccounted for.
  const findings = latest?.findings ?? [];
  const largestDrift = Math.max(0, ...findings.map((f) => Math.abs(f.driftCents ?? 0)));
  const failing = evaluate(findings).filter((c) => c.status !== 'OK').length;

  return (
    <div className="page-controls">
      <PageShell
        logo="◎"
        title="Controls"
        actions={<button
            className="ghost small"
            id="run-control"
            disabled={busy !== null}
            onClick={runNow}
          >
            {busy === 'run' ? 'Running…' : 'Run control now'}
          </button>}
      >
        {!loaded ? (
          <Card>
            <Skeleton />
          </Card>
        ) : !latest ? (
          <Card>
            <EmptyState>
              No reconciliation run recorded yet. The worker runs every 15 seconds — or press
              &ldquo;Run control now&rdquo;.
            </EmptyState>
          </Card>
        ) : (
          <>
            <Card>
              <CardHead title="Latest verdict" aside={`run #${latest.id} · ${ago(latest.startedAt)}`} />
              <div id="verdict" className={`verdict ${status}`}>
                <div className="mark">{MARK[status]}</div>
                <div>
                  <div className="headline">{HEADLINE[status]}</div>
                  <div className="tiny muted">{SUBLINE[status]}</div>
                </div>
              </div>

              <div className="stats" style={{ marginTop: 12 }}>
                <div className="stat">
                  <div className="k">Checks failing</div>
                  <div className="v" id="checks-failing">
                    {`${failing} of 5`}
                  </div>
                </div>
                <div className="stat">
                  <div className="k">Largest disagreement</div>
                  <div className="v" id="largest-drift">
                    {fmt(largestDrift)}
                  </div>
                </div>
                <div className="stat">
                  <div className="k">Accounts checked</div>
                  <div className="v">{latest.checkedAccounts}</div>
                </div>
                <div className="stat">
                  <div className="k">Took</div>
                  <div className="v">{latest.durationMs ?? '–'}ms</div>
                </div>
              </div>

              <p className="note">
                Runs every 15 seconds whether anyone is watching or not — drift only found when
                someone goes looking has already been live for a while. One corruption usually
                trips several checks at once: a balance edited by $50 breaks that account&rsquo;s
                own ledger comparison, the closed-books total, and the read-model comparison
                simultaneously. The figure above is the largest single disagreement, not the sum
                of them, so it is the amount actually unaccounted for.
              </p>
            </Card>

            <ChecksList findings={latest.findings} />

            <div className="grid">
              <div>
                <Card>
                  <CardHead title="Prove it" aside="demo controls" />
                  <div className="controls-row">
                    <button id="break-books" className="danger" disabled={busy !== null} onClick={breakBooks}>
                      {busy === 'drift' ? 'Breaking…' : 'Break the books'}
                    </button>
                    <button id="repair" className="primary" disabled={busy !== null} onClick={repair}>
                      {busy === 'repair' ? 'Repairing…' : 'Repair from journal'}
                    </button>
                  </div>
                  <p className="note">
                    <strong>Break the books</strong> moves $50 onto a random balance without
                    posting a journal entry for it — the one thing double-entry is meant to make
                    impossible through the API. Nothing errors. The wallet keeps working. Within
                    fifteen seconds the control names the account and the amount.
                  </p>
                  <p className="note">
                    <strong>Repair</strong> recomputes every cached balance by adding its journal
                    lines back up. It is safe because the journal is append-only: the ledger is
                    never what needs fixing, only the number cached beside it. No correcting entry
                    is posted, because no money moved.
                  </p>
                  {output !== null && <pre id="control-output">{output}</pre>}
                </Card>
              </div>

              <div>
                <Card>
                  <CardHead title="Run history" aside={`last ${history.length}`} />
                  <div className="sparks" title="drift per run, oldest on the left">
                    {[...history].reverse().map((run) => (
                      <div
                        key={run.id}
                        className={`spark ${run.status}`}
                        style={{
                          height: `${Math.max(6, (Math.abs(run.driftCents) / maxDrift) * 100)}%`,
                        }}
                      />
                    ))}
                  </div>
                  <div className="scroll" style={{ marginTop: 10 }}>
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Run</th>
                          <th scope="col">When</th>
                          <th scope="col">Status</th>
                          <th scope="col" className="num">Drift</th>
                          <th scope="col" className="num">ms</th>
                        </tr>
                      </thead>
                      <tbody id="recon-history">
                        {history.map((run) => (
                          <tr key={run.id}>
                            <td>#{run.id}</td>
                            <td>{new Date(run.startedAt).toLocaleTimeString()}</td>
                            <td>
                              <span className={`sev ${run.status}`}>{run.status}</span>
                            </td>
                            <td className="num">{fmt(run.driftCents)}</td>
                            <td className="num">{run.durationMs ?? '–'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="note">
                    Every pass is kept, so drift has a first sighting rather than just a red
                    light. The bars are total disagreement per run, oldest on the left.
                  </p>
                </Card>
              </div>
            </div>
          </>
        )}
      </PageShell>
    </div>
  );
}
