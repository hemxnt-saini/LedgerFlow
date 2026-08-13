import { useCallback, useRef, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { ChevronDownIcon, LogOutIcon } from '../../components/Icon';
import { useOnClickOutside } from '../../hooks/useOnClickOutside';
import { fmt } from '../../lib/money';
import type { Account } from '../../types/api';

interface Props {
  me: Account;
  accounts: Account[];
  balances: Record<string, number>;
  onSwitch: (accountId: string) => void;
  onSignOut: () => void;
}

/**
 * The account switcher.
 *
 * This button has always shown a name and a chevron, which promises a menu -
 * and then signed you straight out to the account picker instead. Switching
 * from Alice to Bob meant losing your place, waiting for a full landing page
 * to load, and hunting for a card. The chevron now opens what it advertised:
 * everyone else, one click away, plus the sign-out that used to be the whole
 * behaviour.
 */
export function AccountMenu({ me, accounts, balances, onSwitch, onSignOut }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useOnClickOutside(
    wrapperRef,
    useCallback(() => setOpen(false), []),
    open,
  );

  const others = accounts.filter((account) => account.id !== me.id);
  const balanceOf = (account: Account) => balances[account.id] ?? account.balanceCents;

  return (
    <div className="bell" ref={wrapperRef}>
      <button
        id="switch-user"
        className="ghost small account-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Signed in as ${me.name}. Switch account.`}
      >
        <Avatar name={me.name} />
        <span id="me-name">{me.name}</span>
        <ChevronDownIcon size={13} />
      </button>

      <div
        id="account-menu"
        className={`panel account-panel${open ? '' : ' hidden'}`}
        role="menu"
        aria-label="Account"
      >
        <div className="account-current">
          <Avatar name={me.name} />
          <div className="grow stack" style={{ minWidth: 0 }}>
            <div className="small truncate">{me.name}</div>
            <div className="tiny muted">{fmt(balanceOf(me))}</div>
          </div>
        </div>

        {others.length > 0 && (
          <>
            <div className="menu-label">Switch to</div>
            <div className="list">
              {others.map((account) => (
                <button
                  key={account.id}
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onSwitch(account.id);
                  }}
                >
                  <Avatar name={account.name} />
                  <span className="grow truncate" style={{ textAlign: 'left' }}>
                    {account.name}
                  </span>
                  <span className="tiny muted" style={{ flex: 'none' }}>
                    {fmt(balanceOf(account))}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        <button
          id="sign-out"
          className="menu-item danger-text"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onSignOut();
          }}
        >
          <LogOutIcon size={15} />
          <span className="grow" style={{ textAlign: 'left' }}>
            Sign out
          </span>
        </button>
      </div>
    </div>
  );
}
