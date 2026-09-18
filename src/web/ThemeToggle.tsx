import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';

type Theme = 'light' | 'dark';

const storageKey = 'foggybrain-theme';

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#151b18' : '#f7f8f2');
}

export function initializeTheme() {
  let theme: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch {
    // The selected theme still works when browser storage is unavailable.
  }
  applyTheme(theme);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  const dark = theme === 'dark';

  function toggle() {
    const next = dark ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // The selected theme still applies for the current session.
    }
  }

  return (
    <button
      className="theme-toggle"
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
      title={`Switch to ${dark ? 'light' : 'dark'} mode`}
      onClick={toggle}
    >
      <span className="theme-toggle-thumb">{dark ? <Moon size={12} /> : <Sun size={12} />}</span>
    </button>
  );
}
