import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';

const read = (): ThemePreference => {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
};

/**
 * Writes the choice onto <html> so the token file can act on it.
 *
 * "system" removes the attribute rather than resolving it here, which is what
 * lets the media query in tokens.css keep following the OS live - resolving
 * it in JS would freeze the theme at whatever it was on load.
 */
function apply(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(read);

  useEffect(() => {
    apply(preference);
  }, [preference]);

  const setTheme = useCallback((next: ThemePreference) => {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    setPreference(next);
  }, []);

  /** What is actually on screen right now, system preference included. */
  const resolved: Exclude<ThemePreference, 'system'> =
    preference === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : preference;

  return { preference, resolved, setTheme };
}

/**
 * Applied before React mounts, from index.html, so a dark-mode user never
 * sees a white flash while the bundle parses.
 */
export function applyStoredThemeEarly() {
  apply(read());
}
