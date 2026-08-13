import { AlertIcon, CheckIcon, CrossIcon, InfoIcon } from './Icon';
import { useToasts, type Tone } from '../hooks/useToasts';

const ICON: Record<Tone, typeof CheckIcon> = {
  good: CheckIcon,
  warn: AlertIcon,
  bad: AlertIcon,
  '': InfoIcon,
};

/**
 * Transient feedback that screen readers also get.
 *
 * The container is rendered unconditionally and carries the live region, so
 * assistive tech is already watching when a toast appears. Announcing from a
 * node that is inserted at the same moment is unreliable - the region has to
 * exist first.
 *
 * `polite` rather than `assertive`: these confirm things that already
 * happened, and interrupting someone mid-sentence to say a payment succeeded
 * is worse than telling them a second later.
 */
export function Toasts() {
  const { toasts, dismiss } = useToasts();

  return (
    <div
      id="toasts"
      className="toasts"
      role="status"
      aria-live="polite"
      aria-relevant="additions"
    >
      {toasts.map((item) => {
        const Icon = ICON[item.tone];
        return (
          <div key={item.id} className={`toast ${item.tone}`.trim()}>
            <Icon className="toast-icon" />
            <span className="grow">{item.text}</span>
            <button
              className="toast-close"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss notification"
            >
              <CrossIcon size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
