import { Audio } from '@remotion/media';
import { AbsoluteFill, Sequence, staticFile, useVideoConfig } from 'remotion';
import { Act1Illusion } from '../scenes/Act1Illusion';
import { Act2Builder } from '../scenes/Act2Builder';
import { Act3Ide } from '../scenes/Act3Ide';
import { Act4EvidencePeer } from '../scenes/Act4EvidencePeer';
import { Act5SynthesisHandoff } from '../scenes/Act5SynthesisHandoff';
import { Act6HorizonFinale } from '../scenes/Act6HorizonFinale';
import '../campaign.css';

export const HERO_MASTER_SECONDS = 84;

/**
 * FILM 01 — HIREARCHY LAUNCH FILM (1920x1080 @ 60fps, 84 seconds)
 * 6-Act Anthropic-caliber Launch Masterpiece:
 *   00.0 – 11.5s: Act I   — The Illusion (Two 100%s -> "The work is everything.")
 *   11.5 – 21.5s: Act II  — The Real Task (Assessment Builder + Kimi AI Gen + Live Controls)
 *   21.5 – 39.0s: Act III — The Authentic IDE (Docker pytest fail->pass + Neutral AI + 2x Macro Code)
 *   39.0 – 55.0s: Act IV  — Chronology (Δ deltas), Unified Diff + GitHub-PR-Style Peer Review
 *   55.0 – 71.0s: Act V   — Live Kimi K3.1 Pro Advisory Review + Human Sovereignty + Portal & Handoff
 *   71.0 – 84.0s: Act VI  — Common Thread Horizon (Software/IT/Marketing) + "Evidence informs. People decide."
 */
export function HeroMaster16x9() {
  const { fps } = useVideoConfig();
  const f = (sec: number) => Math.round(sec * fps);

  return (
    <AbsoluteFill className="hc-root">
      <Sequence
        name="Act I — The Illusion"
        from={f(0)}
        durationInFrames={f(12.2)}
      >
        <Act1Illusion />
      </Sequence>

      <Sequence
        name="Act II — Assessment Builder"
        from={f(11.5)}
        durationInFrames={f(10.8)}
        premountFor={fps}
      >
        <Act2Builder />
      </Sequence>

      <Sequence
        name="Act III — Authentic IDE"
        from={f(21.5)}
        durationInFrames={f(18.2)}
        premountFor={fps}
      >
        <Act3Ide />
      </Sequence>

      <Sequence
        name="Act IV — Chronology & Peer Review"
        from={f(39.0)}
        durationInFrames={f(16.7)}
        premountFor={fps}
      >
        <Act4EvidencePeer />
      </Sequence>

      <Sequence
        name="Act V — Advisory AI, Human Verdict & Handoff"
        from={f(55.0)}
        durationInFrames={f(16.8)}
        premountFor={fps}
      >
        <Act5SynthesisHandoff />
      </Sequence>

      <Sequence
        name="Act VI — Common Thread Horizon & Finale"
        from={f(71.0)}
        durationInFrames={f(13.0)}
        premountFor={fps}
      >
        <Act6HorizonFinale />
      </Sequence>

      <Audio
        name="Hirearchy Master Score & Tactile Foley"
        src={staticFile('audio/master-16x9.wav')}
        premountFor={fps}
      />
    </AbsoluteFill>
  );
}
