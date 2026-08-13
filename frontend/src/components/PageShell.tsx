import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LiveDot } from './LiveDot';
import { ThemeToggle } from './ThemeToggle';

/**
 * Every destination, on every page.
 *
 * The app grew to six pages while the navigation stayed a row of 12px text
 * links in a corner, which hid most of the product from anyone who did not
 * already know it was there. A tab bar that marks where you are costs nothing
 * and states the scope up front.
 */
const TABS = [
  { to: '/', label: 'Wallet', end: true },
  { to: '/ledger', label: 'Ledger' },
  { to: '/ops', label: 'Reviews' },
  { to: '/controls', label: 'Controls' },
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/kafka', label: 'Kafka' },
];

interface Props {
  logo: string;
  title: string;
  /** Omitted on pages with no live stream of their own. */
  connected?: boolean;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function PageShell({ logo, title, connected, subtitle, actions, children }: Props) {
  return (
    <>
      {/* Without this the tab order walks the whole nav before any content,
          on every page, every time. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden="true">
            {logo}
          </div>
          <div>
            <h1>{title}</h1>
            <div className="tiny muted">
              {connected === undefined ? subtitle : <LiveDot connected={connected} />}
            </div>
          </div>
        </div>

        <nav className="tabs" aria-label="Sections">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              // NavLink already sets aria-current="page" when active, which is
              // the same fact the highlight conveys visually.
              className={({ isActive }) => `tab${isActive ? ' on' : ''}`}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <div className="row">
          {actions}
          <ThemeToggle />
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
