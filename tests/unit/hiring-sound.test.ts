import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isHirearchySoundEnabled,
  playHirearchySound,
  setHirearchySoundEnabled,
  SOUND_CHANGE_EVENT,
  SOUND_STORAGE_KEY,
  toggleHirearchySound,
} from '../../apps/web/src/ui/sound';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Hirearchy brand sound controls', () => {
  it('defaults to enabled and safely no-ops without AudioContext in server environments', () => {
    expect(isHirearchySoundEnabled()).toBe(true);
    expect(() => playHirearchySound('confirm')).not.toThrow();
    expect(() => playHirearchySound('submit')).not.toThrow();
    expect(() => playHirearchySound('dispatch')).not.toThrow();
    expect(() => playHirearchySound('complete')).not.toThrow();
    expect(() => playHirearchySound('error')).not.toThrow();
  });

  it('persists mute state and emits change events in browser environments', () => {
    const store = new Map<string, string>();
    const dispatched: string[] = [];

    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
      dispatchEvent: (event: Event) => {
        dispatched.push(event.type);
        return true;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    expect(isHirearchySoundEnabled()).toBe(true);
    setHirearchySoundEnabled(false);
    expect(store.get(SOUND_STORAGE_KEY)).toBe('off');
    expect(isHirearchySoundEnabled()).toBe(false);
    expect(dispatched).toContain(SOUND_CHANGE_EVENT);

    const toggled = toggleHirearchySound();
    expect(toggled).toBe(true);
    expect(store.get(SOUND_STORAGE_KEY)).toBe('on');
    expect(isHirearchySoundEnabled()).toBe(true);
  });
});
