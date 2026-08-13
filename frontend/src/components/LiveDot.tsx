/**
 * The connection indicator.
 *
 * "reconnecting…" is honest rather than alarming: EventSource retries on its
 * own and usually wins. The state is carried in text as well as colour, so it
 * survives both a screen reader and a colour-blind reader.
 */
export function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span className="row" style={{ gap: 'var(--s-2)' }}>
      <span id="live-dot" className={`live-dot ${connected ? 'on' : 'off'}`} aria-hidden="true" />
      <span id="live-label">{connected ? 'live' : 'reconnecting…'}</span>
    </span>
  );
}
