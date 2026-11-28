'use client';

import { useSyncExternalStore } from 'react';

type ThemeMode = 'light' | 'dark';

const THEME_CHANGE_EVENT = 'hirearchy-theme-change';

function readCookieTheme(): ThemeMode | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const match = document.cookie.match(/(?:^|;\s*)hirearchy-theme=(dark|light)/);
  return match?.[1] === 'dark' || match?.[1] === 'light' ? match[1] : null;
}

function readClientTheme(): ThemeMode {
  if (typeof document === 'undefined') {
    return 'light';
  }
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') {
    return attr;
  }
  const cookieTheme = readCookieTheme();
  if (cookieTheme) {
    return cookieTheme;
  }
  try {
    const stored = window.localStorage.getItem('hirearchy-theme');
    if (stored === 'dark' || stored === 'light') {
      return stored;
    }
  } catch {
    // Ignore storage access errors in sandboxed frames.
  }
  return 'light';
}

function getServerTheme(): ThemeMode {
  return 'light';
}

function subscribeTheme(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
  window.addEventListener('storage', onStoreChange);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

function applyThemeToDocument(theme: ThemeMode) {
  if (typeof document === 'undefined') {
    return;
  }
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
  try {
    window.localStorage.setItem('hirearchy-theme', theme);
  } catch {
    // Ignore storage errors.
  }
  document.cookie = `hirearchy-theme=${theme}; path=/; max-age=31536000; samesite=lax`;
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export function useHirearchyTheme(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, readClientTheme, getServerTheme);
}

export function ThemeToggle({
  variant = 'pill',
  className = '',
}: {
  variant?: 'pill' | 'header' | 'floating';
  className?: string;
}) {
  const theme = useHirearchyTheme();
  const isDark = theme === 'dark';
  const nextTheme: ThemeMode = isDark ? 'light' : 'dark';

  function handleToggle() {
    applyThemeToDocument(nextTheme);
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={`hiring-theme-toggle hiring-theme-toggle--${variant}${className ? ` ${className}` : ''}`}
      aria-label={`Switch to ${nextTheme} theme`}
      aria-pressed={isDark}
      data-theme-state={theme}
      title={`Switch to ${nextTheme} theme`}
    >
      <span className="hiring-theme-toggle-icon" aria-hidden="true">
        {isDark ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2" />
            <path d="M12 20v2" />
            <path d="m4.93 4.93 1.41 1.41" />
            <path d="m17.66 17.66 1.41 1.41" />
            <path d="M2 12h2" />
            <path d="M20 12h2" />
            <path d="m6.34 17.66-1.41 1.41" />
            <path d="m19.07 4.93-1.41 1.41" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
          </svg>
        )}
      </span>
      <span className="hiring-theme-toggle-label">
        {isDark ? 'Light' : 'Dark'}
      </span>
    </button>
  );
}
