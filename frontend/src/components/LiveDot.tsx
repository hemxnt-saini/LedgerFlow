/**
 * The connection indicator. "reconnecting…" is honest rather than alarming:
 * EventSource retries on its own and usually wins.
 */
export function LiveDot({ connected }: { connected: boolean }) {
  return (
    <>
      <span id="live-dot" className={`live-dot ${connected ? 'on' : 'off'}`} />{' '}
      <span id="live-label">{connected ? 'live' : 'reconnecting…'}</span>
    </>
  );
}
