import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A dialog that behaves like one: Escape closes it, a click on the backdrop
 * closes it, focus moves in on open and returns to whatever opened it on
 * close. Cheap to get right, and conspicuous when it is missing.
 */
export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    modalRef.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => openerRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" ref={modalRef}>
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
