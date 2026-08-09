import { useEffect, type RefObject } from 'react';

/** Closes a popover when the next click lands anywhere else on the page. */
export function useOnClickOutside(
  ref: RefObject<HTMLElement>,
  handler: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) handler();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [ref, handler, enabled]);
}
