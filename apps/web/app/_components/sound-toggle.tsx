'use client';

import { useSyncExternalStore } from 'react';
import {
  isHirearchySoundEnabled,
  playHirearchySound,
  subscribeHirearchySound,
  toggleHirearchySound,
} from '../../src/ui/sound';

function getServerSoundEnabled(): boolean {
  return true;
}

export function useHirearchySoundEnabled(): boolean {
  return useSyncExternalStore(
    subscribeHirearchySound,
    isHirearchySoundEnabled,
    getServerSoundEnabled,
  );
}

export function SoundToggle({
  variant = 'pill',
  className = '',
}: Readonly<{
  variant?: 'pill' | 'header';
  className?: string;
}>) {
  const enabled = useHirearchySoundEnabled();

  function handleToggle() {
    const next = toggleHirearchySound();
    if (next) {
      playHirearchySound('confirm');
    }
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={`hiring-theme-toggle hiring-sound-toggle hiring-theme-toggle--${variant}${className ? ` ${className}` : ''}`}
      aria-label={
        enabled ? 'Mute subtle action sounds' : 'Enable subtle action sounds'
      }
      aria-pressed={enabled}
      data-sound-state={enabled ? 'on' : 'off'}
      title={
        enabled
          ? 'Action sounds on — click to mute'
          : 'Action sounds muted — click to enable'
      }
    >
      <span className="hiring-theme-toggle-icon" aria-hidden="true">
        {enabled ? (
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
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
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
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <line x1="22" x2="16" y1="9" y2="15" />
            <line x1="16" x2="22" y1="9" y2="15" />
          </svg>
        )}
      </span>
      <span className="hiring-theme-toggle-label">
        {enabled ? 'Sound' : 'Muted'}
      </span>
    </button>
  );
}
