import { Card, CardHead } from '../../components/Card';
import { fmt } from '../../lib/money';
import type { AccountLimitsView } from '../../types/api';

/**
 * What this wallet is allowed to send, and how much of it is gone.
 *
 * A limit nobody can see only ever shows up as a mysterious decline, so the
 * headroom is on the dashboard before it is needed rather than in the error
 * message afterwards.
 */
export function LimitsCard({ data }: { data: AccountLimitsView | null }) {
  if (!data) return null;

  const { limits, usage, remainingTodayCents } = data;
  const usedPct =
    limits.dailyLimitCents === 0
      ? 100
      : Math.min(100, (usage.todayCents / limits.dailyLimitCents) * 100);
  const tone = usedPct >= 100 ? 'bad' : usedPct >= 80 ? 'warn' : 'good';

  return (
    <Card>
      <CardHead title="Sending limits" aside="checked when the money moves" />

      <div className="spread" style={{ marginBottom: 6 }}>
        <span className="small">
          <span id="limit-used">{fmt(usage.todayCents)}</span> of{' '}
          <span id="limit-daily">{fmt(limits.dailyLimitCents)}</span> today
        </span>
        <span className="small muted" id="limit-remaining">
          {`${fmt(remainingTodayCents)} left`}
        </span>
      </div>

      <div className="meter">
        <div className={`meter-fill ${tone}`} style={{ width: `${usedPct}%` }} />
      </div>

      <div className="stats" style={{ marginTop: 12 }}>
        <div className="stat">
          <div className="k">Per payment</div>
          <div className="v" id="limit-max-payment">
            {fmt(limits.maxPaymentCents)}
          </div>
        </div>
        <div className="stat">
          <div className="k">Daily</div>
          <div className="v">{fmt(limits.dailyLimitCents)}</div>
        </div>
        <div className="stat">
          <div className="k">Rate</div>
          <div className="v" id="limit-velocity">
            {`${limits.velocityMax}/${usage.windowSeconds}s`}
          </div>
        </div>
        <div className="stat">
          <div className="k">Sent just now</div>
          <div className="v" id="limit-recent">
            {usage.recentCount}
          </div>
        </div>
      </div>

      <p className="tiny muted" style={{ marginTop: 10, marginBottom: 0 }}>
        These are re-checked inside the same transaction that debits you, with your
        account row locked — so twenty payments sent at once cannot slip past the cap
        together. This panel is the advisory copy; the transaction is the authority.
      </p>
    </Card>
  );
}
