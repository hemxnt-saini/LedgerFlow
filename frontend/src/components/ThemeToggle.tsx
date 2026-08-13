import { MoonIcon, SunIcon } from './Icon';
import { useTheme } from '../hooks/useTheme';

/**
 * Light / dark, with a third state that means "keep following the system".
 *
 * A two-way switch is the common shortcut and it is wrong: once someone has
 * clicked it there is no way back to following the OS, so an evening
 * auto-switch never happens again. Cycling through system keeps that
 * reachable without a menu.
 */
export function ThemeToggle() {
  const { preference, resolved, setTheme } = useTheme();

  const next =
    preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system';
  const label =
    preference === 'system'
      ? `Theme: following system (${resolved}). Switch to light.`
      : preference === 'light'
        ? 'Theme: light. Switch to dark.'
        : 'Theme: dark. Follow system.';

  return (
    <button
      id="theme-toggle"
      className="ghost icon"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
      data-theme-preference={preference}
    >
      {resolved === 'dark' ? <MoonIcon /> : <SunIcon />}
      {preference === 'system' && <span className="theme-auto" aria-hidden="true" />}
    </button>
  );
}
