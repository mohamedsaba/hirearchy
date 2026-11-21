'use client';

export type HirearchySoundCue =
  'confirm' | 'dispatch' | 'submit' | 'complete' | 'error';

export const SOUND_STORAGE_KEY = 'hirearchy-sound';
export const SOUND_CHANGE_EVENT = 'hirearchy-sound-change';

type ToneStep = Readonly<{
  frequency: number;
  harmonic?: number;
  offsetSec: number;
  durationSec: number;
  gain: number;
  type: OscillatorType;
  lowpassHz: number;
}>;

const SOUND_PROFILES: Record<HirearchySoundCue, readonly ToneStep[]> = {
  // Warm ascending fifth: checkpoint saved, peer review submitted.
  confirm: [
    {
      frequency: 587.33, // D5
      offsetSec: 0,
      durationSec: 0.14,
      gain: 0.045,
      type: 'sine',
      lowpassHz: 2000,
    },
    {
      frequency: 880, // A5
      offsetSec: 0.065,
      durationSec: 0.22,
      gain: 0.04,
      type: 'triangle',
      lowpassHz: 1900,
    },
  ],
  // Calm editorial dispatch: peer review email sent, assessment issued.
  dispatch: [
    {
      frequency: 659.25, // E5
      offsetSec: 0,
      durationSec: 0.15,
      gain: 0.044,
      type: 'sine',
      lowpassHz: 2100,
    },
    {
      frequency: 987.77, // B5
      offsetSec: 0.08,
      durationSec: 0.24,
      gain: 0.036,
      type: 'sine',
      lowpassHz: 2000,
    },
  ],
  // Grounded major triad resolution: candidate final submit, decision published.
  submit: [
    {
      frequency: 523.25, // C5
      offsetSec: 0,
      durationSec: 0.26,
      gain: 0.045,
      type: 'sine',
      lowpassHz: 1850,
    },
    {
      frequency: 659.25, // E5
      offsetSec: 0.055,
      durationSec: 0.28,
      gain: 0.04,
      type: 'sine',
      lowpassHz: 1950,
    },
    {
      frequency: 783.99, // G5
      offsetSec: 0.11,
      durationSec: 0.36,
      gain: 0.038,
      type: 'triangle',
      lowpassHz: 1750,
    },
  ],
  // Soft resonant finish: verification run complete, AI review / fit report ready.
  complete: [
    {
      frequency: 739.99, // F#5
      offsetSec: 0,
      durationSec: 0.16,
      gain: 0.038,
      type: 'sine',
      lowpassHz: 2200,
    },
    {
      frequency: 880, // A5
      offsetSec: 0.075,
      durationSec: 0.24,
      gain: 0.034,
      type: 'sine',
      lowpassHz: 2100,
    },
  ],
  // Restrained low muted interval: calm error notice, never shrill.
  error: [
    {
      frequency: 329.63, // E4
      offsetSec: 0,
      durationSec: 0.13,
      gain: 0.042,
      type: 'triangle',
      lowpassHz: 950,
    },
    {
      frequency: 261.63, // C4
      offsetSec: 0.08,
      durationSec: 0.19,
      gain: 0.04,
      type: 'triangle',
      lowpassHz: 850,
    },
  ],
};

let sharedContext: AudioContext | null = null;

function resolveAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    if (!sharedContext || sharedContext.state === 'closed') {
      sharedContext = new Ctor();
    }
    if (sharedContext.state === 'suspended') {
      void sharedContext.resume().catch(() => undefined);
    }
    return sharedContext;
  } catch {
    return null;
  }
}

export function isHirearchySoundEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(SOUND_STORAGE_KEY);
    if (stored === 'off') return false;
    if (stored === 'on') return true;
  } catch {
    // Ignore restricted storage access.
  }
  return true;
}

export function setHirearchySoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Ignore restricted storage access.
  }
  window.dispatchEvent(new Event(SOUND_CHANGE_EVENT));
}

export function toggleHirearchySound(): boolean {
  const next = !isHirearchySoundEnabled();
  setHirearchySoundEnabled(next);
  return next;
}

export function subscribeHirearchySound(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(SOUND_CHANGE_EVENT, onStoreChange);
  window.addEventListener('storage', onStoreChange);
  return () => {
    window.removeEventListener(SOUND_CHANGE_EVENT, onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

export function playHirearchySound(cue: HirearchySoundCue): void {
  if (!isHirearchySoundEnabled()) return;
  const ctx = resolveAudioContext();
  if (!ctx) return;

  const steps = SOUND_PROFILES[cue];
  const baseTime = ctx.currentTime + 0.008;

  try {
    for (const step of steps) {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      osc.type = step.type;
      osc.frequency.setValueAtTime(step.frequency, baseTime + step.offsetSec);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(
        step.lowpassHz,
        baseTime + step.offsetSec,
      );
      filter.Q.setValueAtTime(0.7, baseTime + step.offsetSec);

      const start = baseTime + step.offsetSec;
      const attackEnd = start + 0.014;
      const end = start + step.durationSec;

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(step.gain, attackEnd);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch {
    // Audio playback is strictly progressive enhancement.
  }
}
