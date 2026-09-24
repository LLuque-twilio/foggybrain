import { Monitor, Moon, Sun, SunMedium } from 'lucide-react';
import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'mist' | 'dusk' | 'clarity' | 'clarity-dark';
type ColorScheme = 'light' | 'dark';

const storageKey = 'foggybrain-theme';
const listeners = new Set<() => void>();
let initialized = false;

export const themeOptions: ReadonlyArray<{
  value: ThemePreference;
  name: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    value: 'system',
    name: 'System',
    description: 'Follow this device’s light or dark appearance.',
    icon: Monitor,
  },
  {
    value: 'mist',
    name: 'Mist',
    description: 'A calm, warm light theme for everyday use.',
    icon: Sun,
  },
  {
    value: 'dusk',
    name: 'Dusk',
    description: 'A low-glare dark theme for dim environments.',
    icon: Moon,
  },
  {
    value: 'clarity',
    name: 'Clarity',
    description: 'Higher contrast with stronger borders and focus cues.',
    icon: SunMedium,
  },
  {
    value: 'clarity-dark',
    name: 'Clarity Dark',
    description: 'Higher contrast with a low-glare dark background.',
    icon: Moon,
  },
];

function normalizePreference(value: string | null): ThemePreference {
  if (value === 'dark') return 'dusk';
  if (value === 'light') return 'mist';
  if (
    value === 'system' ||
    value === 'mist' ||
    value === 'dusk' ||
    value === 'clarity' ||
    value === 'clarity-dark'
  )
    return value;
  return 'system';
}

function getPreference(): ThemePreference {
  return normalizePreference(document.documentElement.dataset.themePreference ?? null);
}

function getThemeSnapshot() {
  return `${getPreference()}:${document.documentElement.dataset.theme ?? 'light'}`;
}

function effectiveScheme(preference: ThemePreference): ColorScheme {
  if (preference === 'dusk' || preference === 'clarity-dark') return 'dark';
  if (preference !== 'system') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(preference: ThemePreference) {
  const scheme = effectiveScheme(preference);
  const root = document.documentElement;
  root.dataset.themePreference = preference;
  root.dataset.theme = scheme;
  root.dataset.themePreset = preference === 'system' ? scheme : preference;
  root.style.colorScheme = scheme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      'content',
      preference === 'clarity-dark'
        ? '#090d0c'
        : scheme === 'dark'
          ? '#151b18'
          : preference === 'clarity'
            ? '#ffffff'
            : '#f7f8f2',
    );
}

function notify() {
  for (const listener of listeners) listener();
}

export function setThemePreference(preference: ThemePreference) {
  applyTheme(preference);
  try {
    window.localStorage.setItem(storageKey, preference);
  } catch {
    // The preference still applies for the current session when storage is unavailable.
  }
  notify();
}

export function initializeTheme() {
  let preference = getPreference();
  try {
    preference = normalizePreference(window.localStorage.getItem(storageKey));
  } catch {
    // The system preference remains available when storage is unavailable.
  }
  applyTheme(preference);
  if (initialized) return;
  initialized = true;

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getPreference() === 'system') {
      applyTheme('system');
      notify();
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey) return;
    applyTheme(normalizePreference(event.newValue));
    notify();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference() {
  const snapshot = useSyncExternalStore(subscribe, getThemeSnapshot, () => 'system:light');
  return snapshot.split(':')[0] as ThemePreference;
}

export function ThemeToggle() {
  const preference = useThemePreference();
  const dark = document.documentElement.dataset.theme === 'dark';

  function toggle() {
    setThemePreference(dark ? 'mist' : 'dusk');
  }

  return (
    <button
      className="theme-toggle"
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
      title={`${preference === 'system' ? 'System theme' : 'Theme'}: switch to ${dark ? 'Mist' : 'Dusk'}`}
      onClick={toggle}
    >
      <span className="theme-toggle-thumb">{dark ? <Moon size={12} /> : <Sun size={12} />}</span>
    </button>
  );
}

export function ThemePicker() {
  const preference = useThemePreference();

  return (
    <fieldset className="theme-picker">
      <legend>Color theme</legend>
      <p>Choose an appearance for this browser. Your workspace data is unaffected.</p>
      <div className="theme-options">
        {themeOptions.map((option) => {
          const Icon = option.icon;
          return (
            <label className="theme-option" key={option.value}>
              <input
                type="radio"
                name="color-theme"
                value={option.value}
                checked={preference === option.value}
                onChange={() => setThemePreference(option.value)}
              />
              <span className={`theme-preview theme-preview-${option.value}`} aria-hidden="true">
                <Icon size={18} />
              </span>
              <span>
                <strong>{option.name}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
