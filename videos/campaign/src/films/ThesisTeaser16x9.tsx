import { Audio } from '@remotion/media';
import {
  AbsoluteFill,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  COLORS,
  EASE_CAMERA,
  EASE_EDITORIAL,
  SCENARIO,
  lerp,
  prog,
} from '../tokens';
import {
  BrandWordmark,
  Curtain,
  Pill,
  RevealLine,
  TactileBackdrop,
} from '../components/Primitives';
import '../campaign.css';

export const THESIS_TEASER_SECONDS = 24;

/**
 * FILM 03 — PRE-LAUNCH MANIFESTO TEASER (1920x1080 @ 60fps, 24 seconds)
 * Pure Anthropic-style Day-1 pre-launch intrigue:
 *   00.0 – 05.0s: "AI made final answers cheap." on macro silk & deep plum
 *   05.0 – 10.5s: Two 100%s dissected — 00:41 Paste vs. 14:22 Observable Trajectory
 *   10.5 – 15.5s: 3 crisp editorial flashes (Docker 4 passed -> Δ Chronology -> Kimi 92/100 + Human Seal)
 *   15.5 – 24.0s: Breath -> "Evidence informs. People decide." -> Hirearchy [Software]
 */
function TeaserOpening() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  return (
    <TactileBackdrop kind="opening" t={t} duration={6.0} dim={0.14}>
      <div style={{ position: 'absolute', left: 132, top: 270, width: 1120 }}>
        <div
          className="hc-kicker"
          style={{
            color: COLORS.mint,
            marginBottom: 26,
            opacity: prog(t, 0.25, 0.9),
          }}
        >
          A NEW STANDARD FOR TECHNICAL HIRING
        </div>
        <div
          className="hc-headline"
          style={{ fontSize: 116, color: COLORS.onPlum }}
        >
          <RevealLine p={prog(t, 0.45, 1.35)}>AI made final</RevealLine>
          <RevealLine p={prog(t, 0.72, 1.62)}>
            answers cheap<span style={{ color: COLORS.mint }}>.</span>
          </RevealLine>
        </div>
        <div
          className="hc-subcopy"
          style={{
            marginTop: 34,
            fontSize: 30,
            color: COLORS.onPlumMuted,
            opacity: prog(t, 2.1, 2.95),
          }}
        >
          Scores no longer tell you who can engineer.
        </div>
      </div>
    </TactileBackdrop>
  );
}

function TeaserContrast() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const enter = prog(t, 0, 0.55, EASE_CAMERA);
  const split = prog(t, 1.65, 2.55, EASE_EDITORIAL);

  return (
    <Curtain p={enter} from="right">
      <TactileBackdrop kind="paper" t={t} duration={6.0}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '0 132px',
          }}
        >
          <div
            className="hc-kicker"
            style={{ color: COLORS.mintDeep, marginBottom: 24 }}
          >
            TWO IDENTICAL 100% SUBMISSIONS
          </div>
          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 38 }}
          >
            <div
              className="hc-card"
              style={{
                padding: '44px 46px',
                opacity: lerp(1, 0.58, split),
                borderColor: split > 0.2 ? COLORS.failBorder : COLORS.border,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 18,
                }}
              >
                <span
                  className="hc-kicker"
                  style={{ fontSize: 14, color: COLORS.muted }}
                >
                  CANDIDATE A
                </span>
                <Pill tone="pass">4 / 4 passed</Pill>
              </div>
              <div
                className="hc-tabular"
                style={{
                  fontSize: 112,
                  fontWeight: 680,
                  color: COLORS.ink,
                  letterSpacing: '-0.06em',
                  lineHeight: 0.92,
                }}
              >
                100%
              </div>
              <div
                style={{
                  marginTop: 28,
                  paddingTop: 24,
                  borderTop: `1px solid ${COLORS.border}`,
                  opacity: split,
                }}
              >
                <div
                  className="hc-mono"
                  style={{ fontSize: 18, color: COLORS.fail, fontWeight: 650 }}
                >
                  00:41 elapsed · 1 bulk paste · 0 iterations
                </div>
              </div>
            </div>

            <div
              className="hc-card"
              style={{
                padding: '44px 46px',
                borderColor: split > 0.2 ? COLORS.mintDeep : COLORS.border,
                boxShadow:
                  split > 0.2 ? '0 28px 72px rgba(47,111,84,0.16)' : undefined,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 18,
                }}
              >
                <span
                  className="hc-kicker"
                  style={{ fontSize: 14, color: COLORS.mintDeep }}
                >
                  CANDIDATE B
                </span>
                <Pill tone="pass">4 / 4 passed</Pill>
              </div>
              <div
                className="hc-tabular"
                style={{
                  fontSize: 112,
                  fontWeight: 680,
                  color: COLORS.mintDeep,
                  letterSpacing: '-0.06em',
                  lineHeight: 0.92,
                }}
              >
                100%
              </div>
              <div
                style={{
                  marginTop: 28,
                  paddingTop: 24,
                  borderTop: `1px solid ${COLORS.border}`,
                  opacity: split,
                }}
              >
                <div
                  className="hc-mono"
                  style={{
                    fontSize: 18,
                    color: COLORS.mintDeep,
                    fontWeight: 650,
                  }}
                >
                  14:22 trajectory · Failed → Logged AI → Fixed → Verified
                </div>
              </div>
            </div>
          </div>
        </div>
      </TactileBackdrop>
    </Curtain>
  );
}

function TeaserFlashMontage() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const idx = t < 1.65 ? 0 : t < 3.3 ? 1 : 2;
  const lt = idx === 0 ? t : idx === 1 ? t - 1.65 : t - 3.3;
  const p = prog(lt, 0, 0.45, EASE_EDITORIAL);

  const cards = [
    {
      bg: 'plum' as const,
      kicker: 'AUTHENTIC IDE · DOCKER SANDBOX',
      headline: '4 passed in 0.14s.',
      sub: 'Real repositories. Isolated test execution. Neutral logged AI.',
      accent: COLORS.mint,
      dark: true,
    },
    {
      bg: 'paper' as const,
      kicker: 'OBSERVABLE CHRONOLOGY · TIMING DELTAS',
      headline: 'Every revision in context.',
      sub: 'Unified diffs, anchored notes, and PR-style team peer review.',
      accent: COLORS.mintDeep,
      dark: false,
    },
    {
      bg: 'plum' as const,
      kicker: 'ADVISORY AI · HUMAN REVIEW PACKET',
      headline: 'AI synthesizes. People decide.',
      sub: `Advisory analysis beside ${SCENARIO.evaluatorName}'s immutable human verdict.`,
      accent: COLORS.mint,
      dark: true,
    },
  ];
  const c = cards[idx];

  return (
    <TactileBackdrop kind={c.bg} t={lt} duration={2.0}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 144px',
          opacity: p,
          transform: `translateY(${(1 - p) * 26}px)`,
        }}
      >
        <div
          className="hc-kicker"
          style={{ color: c.accent, marginBottom: 22, fontSize: 17 }}
        >
          {c.kicker}
        </div>
        <div
          className="hc-headline"
          style={{ fontSize: 112, color: c.dark ? COLORS.onPlum : COLORS.ink }}
        >
          {c.headline}
        </div>
        <div
          className="hc-subcopy"
          style={{
            fontSize: 32,
            marginTop: 26,
            color: c.dark ? COLORS.onPlumMuted : COLORS.inkSoft,
          }}
        >
          {c.sub}
        </div>
      </div>
    </TactileBackdrop>
  );
}

function TeaserFinale() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const mani1 = prog(t, 0.55, 1.35);
  const mani2 = prog(t, 1.85, 2.75);
  const maniOut = prog(t, 3.65, 4.15);
  const lockIn = prog(t, 4.05, 4.95);

  return (
    <TactileBackdrop kind="horizon" t={t} duration={8.5} dim={0.18}>
      {t < 4.3 ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            paddingLeft: 136,
            opacity: 1 - maniOut,
          }}
        >
          <div
            className="hc-headline"
            style={{ fontSize: 130, color: COLORS.onPlum }}
          >
            <RevealLine p={mani1}>Evidence informs.</RevealLine>
          </div>
          <div
            className="hc-headline"
            style={{ fontSize: 136, color: COLORS.mint, marginTop: 8 }}
          >
            <RevealLine p={mani2}>People decide.</RevealLine>
          </div>
        </div>
      ) : null}

      {t >= 4.0 ? (
        <div
          style={{
            position: 'absolute',
            left: 132,
            top: 280,
            opacity: lockIn,
            transform: `translateY(${lerp(24, 0, lockIn)}px)`,
          }}
        >
          <BrandWordmark size={78} dark />
          <div
            className="hc-headline"
            style={{ fontSize: 88, color: COLORS.onPlum, marginTop: 42 }}
          >
            Real work. In context<span style={{ color: COLORS.mint }}>.</span>
          </div>
          <div
            className="hc-mono"
            style={{
              fontSize: 22,
              color: COLORS.mint,
              marginTop: 40,
              letterSpacing: '0.04em',
            }}
          >
            hirearchy.io/products/software
          </div>
        </div>
      ) : null}
    </TactileBackdrop>
  );
}

export function ThesisTeaser16x9() {
  const { fps } = useVideoConfig();
  const f = (sec: number) => Math.round(sec * fps);

  return (
    <AbsoluteFill className="hc-root">
      <Sequence from={f(0)} durationInFrames={f(5.5)} name="Teaser Opening">
        <TeaserOpening />
      </Sequence>
      <Sequence
        from={f(5.0)}
        durationInFrames={f(5.8)}
        premountFor={fps}
        name="Teaser Contrast"
      >
        <TeaserContrast />
      </Sequence>
      <Sequence
        from={f(10.5)}
        durationInFrames={f(5.2)}
        premountFor={fps}
        name="Teaser Flash"
      >
        <TeaserFlashMontage />
      </Sequence>
      <Sequence
        from={f(15.5)}
        durationInFrames={f(8.5)}
        premountFor={fps}
        name="Teaser Finale"
      >
        <TeaserFinale />
      </Sequence>
      <Audio src={staticFile('audio/teaser-16x9.wav')} premountFor={fps} />
    </AbsoluteFill>
  );
}
