import { useCallback, useRef, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { BellIcon } from '../../components/Icon';
import { useOnClickOutside } from '../../hooks/useOnClickOutside';
import { ago } from '../../lib/time';
import type { Notification } from './useWalletData';

interface Props {
  items: Notification[];
  unread: number;
  onOpen: () => void;
  onClear: () => void;
}

export function NotificationBell({ items, unread, onOpen, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useOnClickOutside(
    wrapperRef,
    useCallback(() => setOpen(false), []),
    open,
  );

  return (
    <div className="bell" style={{ position: 'relative' }} ref={wrapperRef}>
      <button
        id="bell-btn"
        className="ghost icon"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          setOpen((current) => {
            // Opening the panel is what marks them read - the badge should
            // clear because you looked, not because time passed.
            if (!current) onOpen();
            return !current;
          });
        }}
      >
        <BellIcon />
        <span id="bell-count" className={`count${unread === 0 ? ' hidden' : ''}`}>
          {unread}
        </span>
      </button>

      <div id="bell-panel" className={`panel${open ? '' : ' hidden'}`}>
        <div className="spread" style={{ marginBottom: 8 }}>
          <h3>Notifications</h3>
          <button id="clear-notifications" className="ghost tiny" onClick={onClear}>
            Clear
          </button>
        </div>
        <div id="notifications" className="list">
          {items.length === 0 ? (
            <EmptyState icon={null}>Nothing new.</EmptyState>
          ) : (
            items.slice(0, 30).map((note, index) => (
              <div className="item flat" key={`${note.at}-${index}`}>
                <div className="grow stack">
                  <div className="small">{note.text}</div>
                  <div className="tiny muted">{ago(note.at)}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
