import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog that behaves like one.
 *
 * Escape closes it, a click on the backdrop closes it, focus moves in on open
 * and back to whatever opened it on close - and, new here, focus cannot leave
 * while it is open. Without the trap, Tab walked straight out of the dialog
 * and into the page behind the scrim, where a keyboard user could operate
 * controls they could not see.
 *
 * The heading is wired up as the accessible name, so it is announced as
 * "Send money, dialog" rather than just "dialog".
 */
export function Modal({
  onClose,
  labelledBy,
  children,
}: {
  onClose: () => void;
  /** Overrides the automatic link to the dialog's own <h2>. */
  labelledBy?: string;
  children: ReactNode;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const headingId = useId();

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;

    // Name the dialog after its own heading unless the caller said otherwise.
    if (!labelledBy) modal?.querySelector('h2')?.setAttribute('id', headingId);
    modal?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    // A dialog over a scrollable page that still scrolls underneath reads as
    // broken, and on iOS it steals the gesture entirely.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const opener = openerRef.current;
    return () => {
      document.body.style.overflow = previousOverflow;
      /**
       * Only if it is still on the page. A row that opened this dialog can be
       * gone by the time it closes - approving a review removes it from the
       * queue - and focusing a detached node silently drops focus to <body>,
       * which sends a keyboard user back to the top of the document. Falling
       * back to the main landmark keeps them roughly where they were.
       */
      if (opener?.isConnected) opener.focus();
      else document.getElementById('main')?.focus();
    };
  }, [headingId, labelledBy]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...(modalRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      // Wrap at both ends, and pull focus back in if it has escaped already.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!modalRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? headingId}
        ref={modalRef}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A label/value row, used by the review screen and the payment detail. The
 * detail modal packs in more rows, so it asks for the smaller type.
 */
export function ReviewLine({
  label,
  value,
  small = false,
}: {
  label: string;
  value: ReactNode;
  small?: boolean;
}) {
  return (
    <div className="review-line">
      <span className="muted small">{label}</span>
      <span className={small ? 'small' : undefined}>{value}</span>
    </div>
  );
}
