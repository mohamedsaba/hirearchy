import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, EASE_CAMERA, EASE_EDITORIAL, lerp, prog } from '../tokens';
import {
  Curtain,
  RevealLine,
  TactileBackdrop,
  ThreadFilament,
} from '../components/Primitives';

/**
 * ACT I — THE ILLUSION (0.0s – 11.5s)
 * Hook & Philosophical Tension:
 *   0.0–1.0s: Tactile deep-plum silk thread plate breathes into focus
 *   1.0–4.2s: Two identical "100% PASSED" receipts materialize side by side
 *   4.2–7.6s: X-ray split — Left flattens to a hollow 00:41 paste;
 *             Right unfolds into a luminous 14:22 engineering trajectory
 *   7.6–11.5s: Daylight archival cotton paper opens into monumental editorial thesis:
 *              "The answer is cheap." / "The work is everything." -> living mint thread!
 */
export function Act1Illusion() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  // Phase timings
  const receiptsIn = prog(t, 0.9, 1.85);
  const captionIn = prog(t, 2.0, 2.75);
  const xray = prog(t, 4.15, 5.15, EASE_EDITORIAL);
  const trajNodes = prog(t, 4.65, 6.65, EASE_CAMERA);
  const paperTurn = prog(t, 7.55, 8.25, EASE_CAMERA);

  // Paper manifesto timings (after breath pause 7.6 -> 8.2s)
  const line1 = prog(t, 8.15, 8.95);
  const line2 = prog(t, 9.35, 10.2);
  const dotBloom = prog(t, 9.85, 10.35);
  const threadExit = prog(t, 9.95, 11.45, EASE_CAMERA);

  const trajectory = [
    { time: '00:00', label: 'Read ledger.py' },
    { time: '03:12', label: '2 tests failed', tone: 'fail' as const },
    { time: '06:48', label: '1 AI query logged', tone: 'ai' as const },
    { time: '11:05', label: 'Fixed state guard', tone: 'mint' as const },
    { time: '13:19', label: '4 / 4 passed', tone: 'pass' as const },
  ];

  return (
    <AbsoluteFill>
      {/* LAYER 1: Deep archival plum studio with Hasselblad silk macro plate */}
      <TactileBackdrop
        kind="opening"
        t={t}
        duration={8.5}
        dim={0.18 + receiptsIn * 0.24}
      >
        {/* Subtle top editorial index */}
        <div
          className="hc-kicker"
          style={{
            position: 'absolute',
            left: 112,
            top: 78,
            color: COLORS.onPlumMuted,
            opacity: prog(t, 0.35, 1.05) * (1 - paperTurn),
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: COLORS.mint,
              display: 'inline-block',
            }}
          />
          HIREARCHY SOFTWARE · FILM 01
        </div>

        {/* Two Stark Receipts Stage */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            paddingBottom: 34,
            opacity: 1 - prog(t, 7.25, 7.7),
            transform: `scale(${lerp(0.97, 1.0, receiptsIn)}) translateY(${lerp(24, 0, receiptsIn)}px)`,
          }}
        >
          {/* Context Header */}
          <div
            className="hc-subcopy"
            style={{
              fontSize: 28,
              color: COLORS.onPlumMuted,
              marginBottom: 42,
              opacity: captionIn,
              transform: `translateY(${(1 - captionIn) * 14}px)`,
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <span>Two candidates.</span>
            <span style={{ color: COLORS.onPlum, fontWeight: 560 }}>
              {xray < 0.35
                ? 'Identical final code.'
                : 'Completely different engineers.'}
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 36,
              alignItems: 'stretch',
            }}
          >
            {/* LEFT RECEIPT: Candidate A -> Collapses into hollow 00:41 copy-paste */}
            <div
              style={{
                width: 560,
                padding: '38px 42px',
                borderRadius: 20,
                background: `rgba(33, 20, 38, ${lerp(0.84, 0.72, xray)})`,
                border: `1px solid ${xray > 0.2 ? 'rgba(255, 138, 128, 0.28)' : 'rgba(245, 239, 230, 0.14)'}`,
                backdropFilter: 'blur(18px)',
                boxShadow: '0 32px 80px rgba(8, 3, 14, 0.5)',
                opacity: lerp(1, 0.62, xray),
                transform: `translateY(${lerp(28, 0, receiptsIn)}px) scale(${lerp(1, 0.965, xray)})`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 24,
                }}
              >
                <span
                  className="hc-kicker"
                  style={{ fontSize: 13, color: COLORS.onPlumMuted }}
                >
                  CANDIDATE A
                </span>
                <span
                  className="hc-mono"
                  style={{
                    fontSize: 13,
                    padding: '5px 11px',
                    borderRadius: 999,
                    background: 'rgba(176, 240, 206, 0.12)',
                    color: COLORS.mint,
                    border: '1px solid rgba(176, 240, 206, 0.26)',
                  }}
                >
                  4 / 4 TESTS PASSED
                </span>
              </div>

              <div
                className="hc-tabular"
                style={{
                  fontSize: 108,
                  fontWeight: 620,
                  letterSpacing: '-0.06em',
                  lineHeight: 0.95,
                  color: xray > 0.2 ? '#c5b8d0' : COLORS.onPlum,
                  marginBottom: 28,
                }}
              >
                100%
              </div>

              {/* X-ray Flat Line Reveal */}
              <div
                style={{
                  borderTop: '1px solid rgba(245, 239, 230, 0.10)',
                  paddingTop: 24,
                  minHeight: 152,
                  opacity: xray,
                  transform: `translateY(${(1 - xray) * 16}px)`,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: 14,
                    fontSize: 15,
                  }}
                >
                  <span style={{ color: COLORS.failDark, fontWeight: 600 }}>
                    00:41 total elapsed
                  </span>
                  <span
                    className="hc-mono"
                    style={{ color: COLORS.onPlumFaint, fontSize: 13 }}
                  >
                    0 iterations
                  </span>
                </div>
                {/* Hollow flat line */}
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: 'rgba(255, 138, 128, 0.14)',
                    position: 'relative',
                    overflow: 'hidden',
                    marginBottom: 22,
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: 0,
                      bottom: 0,
                      width: `${xray * 14}%`,
                      background: COLORS.failDark,
                      borderRadius: 999,
                    }}
                  />
                </div>
                <div
                  style={{
                    fontSize: 18,
                    color: COLORS.onPlumMuted,
                    lineHeight: 1.45,
                  }}
                >
                  Single bulk paste at <span className="hc-mono">00:39</span>.
                  <br />
                  No exploration, no debugging, no verification trail.
                </div>
              </div>
            </div>

            {/* RIGHT RECEIPT: Candidate B -> Blooms into living mint engineering trajectory */}
            <div
              style={{
                width: 620,
                padding: '38px 42px',
                borderRadius: 20,
                background: 'rgba(37, 23, 46, 0.90)',
                border: `1px solid ${xray > 0.2 ? 'rgba(176, 240, 206, 0.44)' : 'rgba(245, 239, 230, 0.14)'}`,
                backdropFilter: 'blur(18px)',
                boxShadow:
                  xray > 0.2
                    ? '0 36px 96px rgba(6, 2, 12, 0.62), 0 0 0 1px rgba(176, 240, 206, 0.16)'
                    : '0 32px 80px rgba(8, 3, 14, 0.5)',
                transform: `translateY(${lerp(28, 0, prog(t, 1.05, 1.95))}px) scale(${lerp(1, 1.025, xray)})`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 24,
                }}
              >
                <span
                  className="hc-kicker"
                  style={{
                    fontSize: 13,
                    color: xray > 0.2 ? COLORS.mint : COLORS.onPlumMuted,
                  }}
                >
                  CANDIDATE B
                </span>
                <span
                  className="hc-mono"
                  style={{
                    fontSize: 13,
                    padding: '5px 11px',
                    borderRadius: 999,
                    background: 'rgba(176, 240, 206, 0.16)',
                    color: COLORS.mint,
                    border: '1px solid rgba(176, 240, 206, 0.34)',
                  }}
                >
                  4 / 4 TESTS PASSED
                </span>
              </div>

              <div
                className="hc-tabular"
                style={{
                  fontSize: 108,
                  fontWeight: 620,
                  letterSpacing: '-0.06em',
                  lineHeight: 0.95,
                  color: xray > 0.2 ? COLORS.mint : COLORS.onPlum,
                  marginBottom: 28,
                }}
              >
                100%
              </div>

              {/* Luminous Living Trajectory */}
              <div
                style={{
                  borderTop: '1px solid rgba(176, 240, 206, 0.18)',
                  paddingTop: 22,
                  minHeight: 152,
                  opacity: xray,
                  transform: `translateY(${(1 - xray) * 16}px)`,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: 16,
                    fontSize: 15,
                  }}
                >
                  <span style={{ color: COLORS.mint, fontWeight: 600 }}>
                    14:22 observable trajectory
                  </span>
                  <span
                    className="hc-mono"
                    style={{ color: COLORS.onPlumMuted, fontSize: 13 }}
                  >
                    6 verified events
                  </span>
                </div>

                {/* Spine bar */}
                <div
                  style={{
                    position: 'relative',
                    height: 2,
                    background: 'rgba(176, 240, 206, 0.18)',
                    margin: '16px 0 22px',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      height: 2,
                      width: `${trajNodes * 100}%`,
                      background: COLORS.mint,
                      boxShadow: '0 0 12px rgba(176, 240, 206, 0.7)',
                    }}
                  />
                  {trajectory.map((item, idx) => {
                    const threshold = idx / (trajectory.length - 1);
                    const on = trajNodes >= threshold - 0.05;
                    const dotColor =
                      item.tone === 'fail'
                        ? COLORS.failDark
                        : item.tone === 'ai'
                          ? COLORS.purple
                          : COLORS.mint;
                    return (
                      <div
                        key={item.time}
                        style={{
                          position: 'absolute',
                          left: `${threshold * 100}%`,
                          top: -5,
                          width: 12,
                          height: 12,
                          marginLeft: -6,
                          borderRadius: '50%',
                          background: on ? dotColor : COLORS.plumMid,
                          border: `2px solid ${on ? dotColor : COLORS.plumLine}`,
                          transform: `scale(${on ? 1 : 0.6})`,
                        }}
                      />
                    );
                  })}
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(5, 1fr)',
                    gap: 8,
                  }}
                >
                  {trajectory.map((item, idx) => {
                    const pNode = prog(t, 4.65 + idx * 0.34, 5.15 + idx * 0.34);
                    return (
                      <div
                        key={item.time}
                        style={{
                          opacity: pNode,
                          transform: `translateY(${(1 - pNode) * 8}px)`,
                        }}
                      >
                        <div
                          className="hc-mono"
                          style={{
                            fontSize: 11,
                            color: COLORS.onPlumFaint,
                            marginBottom: 4,
                          }}
                        >
                          {item.time}
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            lineHeight: 1.25,
                            color:
                              item.tone === 'fail'
                                ? COLORS.failDark
                                : item.tone === 'pass' || item.tone === 'mint'
                                  ? COLORS.mint
                                  : COLORS.onPlum,
                            fontWeight: 540,
                          }}
                        >
                          {item.label}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </TactileBackdrop>

      {/* LAYER 2: Warm Archival Cotton Rag Manifesto Pivot (7.55s – 11.5s) */}
      {t >= 7.5 ? (
        <Curtain p={paperTurn} from="right">
          <TactileBackdrop kind="paper" t={t - 7.55} duration={4.5}>
            <div
              style={{
                position: 'absolute',
                left: 136,
                top: 320,
                right: 136,
              }}
            >
              <div
                className="hc-headline"
                style={{
                  fontSize: 124,
                  color: COLORS.muted,
                  marginBottom: 14,
                }}
              >
                <RevealLine p={line1}>The answer is cheap.</RevealLine>
              </div>
              <div
                className="hc-headline"
                style={{
                  fontSize: 132,
                  color: COLORS.ink,
                }}
              >
                <RevealLine p={line2}>
                  The work is everything
                  <span
                    style={{
                      color: COLORS.mintDeep,
                      display: 'inline-block',
                      transform: `scale(${lerp(0.4, 1, dotBloom)})`,
                    }}
                  >
                    .
                  </span>
                </RevealLine>
              </div>
            </div>

            {/* Luminous Common Thread emerging from the thesis into Act II */}
            <ThreadFilament
              d="M 140 668 H 1240 Q 1345 668 1420 606 L 1950 470"
              amount={threadExit}
              color={COLORS.mintDeep}
              strokeWidth={3.2}
              opacity={0.78}
              glow={false}
            />
          </TactileBackdrop>
        </Curtain>
      ) : null}
    </AbsoluteFill>
  );
}
