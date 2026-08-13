import type { ReactNode } from 'react';
import { InboxIcon } from './Icon';

/**
 * An empty state that says what would fill it.
 *
 * These were a line of grey text in a dashed box, which leaves someone
 * looking at an empty page unsure whether it is empty or broken. An icon
 * makes it read as a deliberate state, and the optional title/action give it
 * somewhere to go.
 */
export function EmptyState({
  children,
  title,
  icon = <InboxIcon size={26} />,
  action,
}: {
  children: ReactNode;
  title?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon}
      {title && <div className="empty-title">{title}</div>}
      <div>{children}</div>
      {action}
    </div>
  );
}
