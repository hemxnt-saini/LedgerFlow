import { Card, CardHead } from '../../components/Card';
import { fmt } from '../../lib/money';
import type { Finding } from '../../types/api';
import { evaluate } from './checks';

const MARK = { OK: '✓', WARN: '!', DRIFT: '✕' } as const;

/** Expected against actual, when the finding carries both. */
function hitDetail(finding: Finding): string {
  if (finding.expectedCents === undefined || finding.actualCents === undefined) {
    return finding.detail;
  }
  return `${finding.detail} — expected ${fmt(finding.expectedCents)}, found ${fmt(
    finding.actualCents,
  )}`;
}

/**
 * All five checks, always. A pass produces no finding, so listing only
 * failures would show an empty page on a healthy system and say nothing
 * about what was actually verified.
 */
export function ChecksList({ findings }: { findings: Finding[] }) {
  const checks = evaluate(findings);
  const passing = checks.filter((check) => check.status === 'OK').length;

  return (
    <Card>
      <CardHead title="What the control checks" aside={`${passing} of ${checks.length} passing`} />
      <div id="checks" className="checks">
        {checks.map((check) => (
          <div className={`check ${check.status}`} key={check.name}>
            <div className="mark">{MARK[check.status]}</div>
            <div>
              <div className="name">{check.name}</div>
              <div className="proves">{check.proves}</div>
              {check.findings.map((finding, index) => (
                <div className="hit" key={`${finding.code}-${index}`}>
                  <span className={`sev ${finding.severity}`}>{finding.severity}</span>{' '}
                  {hitDetail(finding)}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="note">
        The control runs its own queries rather than reusing the write path's
        repositories. A check that shares the code it is checking verifies nothing.
      </p>
    </Card>
  );
}
