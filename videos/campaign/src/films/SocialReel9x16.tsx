import { Audio } from '@remotion/media';
import {
  AbsoluteFill,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  CHRONOLOGY_EVENTS,
  CODE_ADDED_DEDUPE,
  CODE_ADDED_GUARD,
  COLORS,
  EASE_CAMERA,
  EASE_EDITORIAL,
  KIMI_REVIEW,
  SCENARIO,
  lerp,
  prog,
} from '../tokens';
import {
  BrandWordmark,
  Curtain,
  Pill,
  PythonLine,
  RevealLine,
  TactileBackdrop,
} from '../components/Primitives';
import '../campaign.css';

export const SOCIAL_REEL_SECONDS = 34;

/**
 * FILM 02 — VERTICAL SOCIAL REEL (1080x1920 @ 60fps, 34 seconds)
 * Purpose-built vertical architecture for LinkedIn mobile, X, Reels & Shorts.
 */
function ReelAct1Hook() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const cardsIn = prog(t, 0.35, 1.15);
  const xray = prog(t, 2.75, 3.65, EASE_EDITORIAL);
  const paperTurn = prog(t, 5.05, 5.65, EASE_CAMERA);

  return (
    <AbsoluteFill>
      <TactileBackdrop
        kind="vertical"
        t={t}
        duration={6.0}
        dim={0.22 + cardsIn * 0.22}
      >
        <div
          style={{
            position: 'absolute',
            left: 72,
            right: 72,
            top: 120,
            opacity: 1 - paperTurn,
          }}
        >
          <div
            className="hc-kicker"
            style={{ color: COLORS.mint, fontSize: 15, marginBottom: 20 }}
          >
            HIREARCHY SOFTWARE
          </div>
          <div
            className="hc-headline"
            style={{ fontSize: 74, color: COLORS.onPlum, marginBottom: 56 }}
          >
            <RevealLine p={prog(t, 0.15, 0.8)}>
              {xray < 0.35 ? 'Same 100% score.' : 'Two very different'}
            </RevealLine>
            <RevealLine p={prog(t, 0.3, 0.95)}>
              <span
                style={{
                  color: xray < 0.35 ? COLORS.onPlumMuted : COLORS.mint,
                }}
              >
                {xray < 0.35 ? 'Identical final code.' : 'engineers.'}
              </span>
            </RevealLine>
          </div>

          {/* Candidate A Vertical Card */}
          <div
            style={{
              padding: '34px 36px',
              borderRadius: 22,
              background: 'rgba(33, 20, 38, 0.86)',
              border: `1px solid ${xray > 0.2 ? 'rgba(255,138,128,0.34)' : 'rgba(245,239,230,0.16)'}`,
              marginBottom: 28,
              opacity: cardsIn * lerp(1, 0.65, xray),
              transform: `translateY(${(1 - cardsIn) * 24}px)`,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span
                className="hc-kicker"
                style={{ fontSize: 14, color: COLORS.onPlumMuted }}
              >
                CANDIDATE A
              </span>
              <span
                className="hc-tabular"
                style={{ fontSize: 56, fontWeight: 700, color: COLORS.onPlum }}
              >
                100%
              </span>
            </div>
            <div
              style={{
                marginTop: 20,
                paddingTop: 18,
                borderTop: '1px solid rgba(245,239,230,0.12)',
                opacity: xray,
              }}
            >
              <div
                className="hc-mono"
                style={{
                  fontSize: 16,
                  color: COLORS.failDark,
                  fontWeight: 650,
                }}
              >
                00:41 elapsed · Single bulk paste · 0 iterations
              </div>
              <div
                style={{
                  height: 6,
                  borderRadius: 999,
                  background: 'rgba(255,138,128,0.18)',
                  marginTop: 14,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${xray * 15}%`,
                    height: '100%',
                    background: COLORS.failDark,
                    marginLeft: 'auto',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Candidate B Vertical Card */}
          <div
            style={{
              padding: '34px 36px',
              borderRadius: 22,
              background: 'rgba(37, 23, 46, 0.94)',
              border: `1px solid ${xray > 0.2 ? 'rgba(176,240,206,0.48)' : 'rgba(245,239,230,0.16)'}`,
              boxShadow: '0 28px 80px rgba(6,2,12,0.55)',
              opacity: prog(t, 0.5, 1.25),
              transform: `translateY(${(1 - prog(t, 0.5, 1.25)) * 24}px)`,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span
                className="hc-kicker"
                style={{ fontSize: 14, color: COLORS.mint }}
              >
                CANDIDATE B
              </span>
              <span
                className="hc-tabular"
                style={{ fontSize: 56, fontWeight: 700, color: COLORS.mint }}
              >
                100%
              </span>
            </div>
            <div
              style={{
                marginTop: 20,
                paddingTop: 18,
                borderTop: '1px solid rgba(176,240,206,0.2)',
                opacity: xray,
              }}
            >
              <div
                className="hc-mono"
                style={{
                  fontSize: 16,
                  color: COLORS.mint,
                  fontWeight: 650,
                  marginBottom: 14,
                }}
              >
                14:22 trajectory · 6 observable events
              </div>
              <div
                style={{ fontSize: 20, color: COLORS.onPlum, lineHeight: 1.55 }}
              >
                Read ledger →{' '}
                <span style={{ color: COLORS.failDark }}>2 tests failed</span> →{' '}
                <span style={{ color: COLORS.purple }}>1 logged AI query</span>{' '}
                → fixed state guard →{' '}
                <span style={{ color: COLORS.mint, fontWeight: 650 }}>
                  4/4 passed
                </span>
              </div>
            </div>
          </div>
        </div>
      </TactileBackdrop>

      {t >= 5.0 ? (
        <Curtain p={paperTurn} from="bottom">
          <TactileBackdrop kind="paper" t={t - 5.0} duration={3.0}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                padding: '0 80px',
              }}
            >
              <div
                className="hc-headline"
                style={{ fontSize: 94, color: COLORS.muted, marginBottom: 18 }}
              >
                <RevealLine p={prog(t, 5.25, 5.95)}>The answer</RevealLine>
                <RevealLine p={prog(t, 5.4, 6.05)}>is cheap.</RevealLine>
              </div>
              <div
                className="hc-headline"
                style={{ fontSize: 102, color: COLORS.ink }}
              >
                <RevealLine p={prog(t, 5.8, 6.55)}>The work is</RevealLine>
                <RevealLine p={prog(t, 5.98, 6.72)}>
                  everything<span style={{ color: COLORS.mintDeep }}>.</span>
                </RevealLine>
              </div>
            </div>
          </TactileBackdrop>
        </Curtain>
      ) : null}
    </AbsoluteFill>
  );
}

function ReelAct2Ide() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const enter = prog(t, 0, 0.55, EASE_CAMERA);
  const failShown = prog(t, 1.5, 2.0);
  const fixText = [...CODE_ADDED_DEDUPE, '', ...CODE_ADDED_GUARD].join('\n');
  const typed = fixText.slice(
    0,
    Math.floor(prog(t, 2.8, 6.2, EASE_CAMERA) * fixText.length),
  );
  const passShown = prog(t, 6.55, 7.05);

  return (
    <Curtain p={enter} from="bottom">
      <TactileBackdrop kind="plum" t={t} duration={9.5}>
        <div style={{ position: 'absolute', left: 68, right: 68, top: 118 }}>
          <div
            className="hc-kicker"
            style={{ color: COLORS.mint, fontSize: 15, marginBottom: 16 }}
          >
            01 / AUTHENTIC IDE · ZERO SPYWARE
          </div>
          <div
            className="hc-headline"
            style={{ fontSize: 70, color: COLORS.onPlum, marginBottom: 26 }}
          >
            Real repo. Real tests.
            <br />
            Neutral logged AI.
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 38 }}>
            <Pill tone="darkMint">Docker Sandbox Live</Pill>
            <Pill
              tone="darkMint"
              style={{
                background: 'rgba(187,152,244,0.16)',
                color: COLORS.purple,
                borderColor: 'rgba(187,152,244,0.34)',
              }}
            >
              AI Neutrally Logged
            </Pill>
          </div>

          {/* Vertical IDE Card */}
          <div
            className="hc-window-dark"
            style={{
              background: '#160d1f',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                padding: '18px 24px',
                background: COLORS.plum,
                borderBottom: `1px solid ${COLORS.plumLine}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span
                className="hc-mono"
                style={{ fontSize: 16, color: COLORS.mint, fontWeight: 600 }}
              >
                src/webhook_handler.py
              </span>
              <span
                className="hc-mono"
                style={{ fontSize: 14, color: COLORS.onPlumMuted }}
              >
                {passShown > 0.2 ? 'Saved v2 · 11:05' : '48:19 left'}
              </span>
            </div>

            <div
              className="hc-mono"
              style={{
                padding: '26px 26px',
                fontSize: 17.5,
                lineHeight: 1.72,
                minHeight: 490,
                background: '#130b1b',
              }}
            >
              <div style={{ color: COLORS.onPlumMuted, marginBottom: 10 }}>
                <PythonLine
                  text="def handle_webhook(ledger, event) -> str:"
                  theme="dark"
                />
              </div>
              {typed.split('\n').map((line, i) => (
                <div
                  key={i}
                  style={{
                    background: line.trim()
                      ? 'rgba(176, 240, 206, 0.09)'
                      : 'transparent',
                    borderLeft: line.trim()
                      ? `3px solid ${COLORS.mint}`
                      : '3px solid transparent',
                    paddingLeft: 12,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  <PythonLine text={line || ' '} theme="dark" />
                </div>
              ))}
            </div>

            {/* Live Docker Terminal */}
            <div
              className="hc-mono"
              style={{
                padding: '24px 26px',
                background: '#100816',
                borderTop: `1px solid ${COLORS.plumLine}`,
                fontSize: 15.5,
                lineHeight: 1.65,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                }}
              >
                <span style={{ color: COLORS.mint, fontSize: 13 }}>
                  DOCKER SANDBOX · PYTEST
                </span>
                <span
                  style={{
                    padding: '3px 10px',
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 700,
                    background:
                      passShown > 0.2
                        ? 'rgba(126,230,176,0.18)'
                        : failShown > 0.2
                          ? 'rgba(255,138,128,0.18)'
                          : 'rgba(255,255,255,0.08)',
                    color:
                      passShown > 0.2
                        ? COLORS.passDark
                        : failShown > 0.2
                          ? COLORS.failDark
                          : COLORS.onPlumMuted,
                  }}
                >
                  {passShown > 0.2
                    ? '✓ 4 PASSED · 0.14s'
                    : failShown > 0.2
                      ? '✕ 2 FAILED'
                      : 'RUNNING'}
                </span>
              </div>
              <div style={{ color: '#d7cbe0' }}>
                <span style={{ color: COLORS.mint }}>$</span> pytest
                tests/test_webhooks.py
              </div>
              {passShown > 0.2 ? (
                <div style={{ color: COLORS.passDark, marginTop: 8 }}>
                  ✓ test_duplicate_delivery_is_idempotent PASSED
                  <br />✓ test_out_of_order_authorized_after_settled PASSED
                  <br />✓ 4 passed in 0.14s · Exit 0
                </div>
              ) : failShown > 0.2 ? (
                <div style={{ color: COLORS.failDark, marginTop: 8 }}>
                  FAILED duplicate_delivery (10000 == 5000)
                  <br />
                  FAILED out_of_order_regression
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </TactileBackdrop>
    </Curtain>
  );
}

function ReelAct3ChronologyAdvisory() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const enter = prog(t, 0, 0.5, EASE_CAMERA);
  const advisoryIn = prog(t, 2.55, 3.35, EASE_EDITORIAL);
  const badgePop = prog(t, 3.1, 3.7, EASE_EDITORIAL);

  return (
    <Curtain p={enter} from="right">
      <TactileBackdrop kind="paper" t={t} duration={7.0}>
        <div style={{ position: 'absolute', left: 68, right: 68, top: 106 }}>
          <div
            className="hc-kicker"
            style={{ color: COLORS.mintDeep, fontSize: 15, marginBottom: 14 }}
          >
            02 / CHRONOLOGY &amp; WORKSPACE AI
          </div>
          <div
            className="hc-headline"
            style={{ fontSize: 68, color: COLORS.ink, marginBottom: 34 }}
          >
            Every step in context.
            <br />
            Synthesized cleanly.
          </div>

          {/* Compact Chronology Card */}
          <div
            className="hc-card"
            style={{ padding: '24px 28px', marginBottom: 26 }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 14,
              }}
            >
              <span
                style={{ fontSize: 20, fontWeight: 680, color: COLORS.ink }}
              >
                Recorded Chronology
              </span>
              <span
                className="hc-mono"
                style={{
                  fontSize: 14,
                  color: COLORS.mintDeep,
                  fontWeight: 650,
                }}
              >
                14m 22s
              </span>
            </div>
            {CHRONOLOGY_EVENTS.slice(1).map((ev, i) => {
              const p = prog(t, 0.25 + i * 0.36, 0.7 + i * 0.36);
              return (
                <div
                  key={ev.seq}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '11px 0',
                    borderTop: i > 0 ? `1px solid ${COLORS.border}` : 'none',
                    opacity: p,
                    transform: `translateX(${(1 - p) * 20}px)`,
                  }}
                >
                  <div
                    style={{ fontSize: 17, fontWeight: 600, color: COLORS.ink }}
                  >
                    {ev.title}
                  </div>
                  <span
                    className="hc-mono"
                    style={{
                      fontSize: 13.5,
                      color: COLORS.mintDeep,
                      background: '#edf8f2',
                      padding: '4px 9px',
                      borderRadius: 6,
                      fontWeight: 650,
                    }}
                  >
                    {ev.delta}
                  </span>
                </div>
              );
            })}
          </div>

          {/* ADVISORY AI REVIEW CARD (Qualitative Signal — Zero numeric score!) */}
          <div
            className="hc-window-dark"
            style={{
              background: COLORS.plum,
              padding: '30px 32px',
              opacity: advisoryIn,
              transform: `translateY(${(1 - advisoryIn) * 32}px)`,
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span
                className="hc-mono"
                style={{
                  fontSize: 13,
                  color: COLORS.purple,
                  letterSpacing: '0.12em',
                }}
              >
                ADVISORY AI · CANDIDATE REVIEW
              </span>
              <span
                className="hc-mono"
                style={{ fontSize: 12.5, color: COLORS.onPlumMuted }}
              >
                {KIMI_REVIEW.confidenceLabel}
              </span>
            </div>

            <div
              style={{
                transform: `scale(${lerp(0.95, 1, badgePop)})`,
                transformOrigin: 'left center',
              }}
            >
              <span
                className="hc-mono"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 18px',
                  borderRadius: 999,
                  background: 'rgba(176, 240, 206, 0.16)',
                  border: '1px solid rgba(176, 240, 206, 0.44)',
                  color: COLORS.mint,
                  fontSize: 16.5,
                  fontWeight: 720,
                  letterSpacing: '0.09em',
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background: COLORS.mint,
                  }}
                />
                STRONG SIGNAL · ADVISORY ONLY
              </span>
            </div>

            <div
              style={{ fontSize: 18.5, color: COLORS.onPlum, lineHeight: 1.48 }}
            >
              {KIMI_REVIEW.rationale}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 14,
              }}
            >
              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: 12,
                  background: 'rgba(176, 240, 206, 0.08)',
                  border: '1px solid rgba(176, 240, 206, 0.2)',
                }}
              >
                <div
                  className="hc-mono"
                  style={{
                    fontSize: 11.5,
                    color: COLORS.mint,
                    letterSpacing: '0.1em',
                    marginBottom: 8,
                  }}
                >
                  OBSERVED STRENGTHS
                </div>
                <div
                  style={{ fontSize: 15, color: '#ebe3f2', lineHeight: 1.42 }}
                >
                  + {KIMI_REVIEW.strengths[0]}
                  <br />+ {KIMI_REVIEW.strengths[1]}
                </div>
              </div>
              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: 12,
                  background: 'rgba(255, 155, 136, 0.08)',
                  border: '1px solid rgba(255, 155, 136, 0.22)',
                }}
              >
                <div
                  className="hc-mono"
                  style={{
                    fontSize: 11.5,
                    color: COLORS.coral,
                    letterSpacing: '0.1em',
                    marginBottom: 8,
                  }}
                >
                  VERIFICATION GAPS
                </div>
                <div
                  style={{ fontSize: 15, color: '#ebe3f2', lineHeight: 1.42 }}
                >
                  ! {KIMI_REVIEW.weaknesses[0]}
                </div>
              </div>
            </div>
          </div>
        </div>
      </TactileBackdrop>
    </Curtain>
  );
}

function ReelAct4HumanAndHandoff() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const enter = prog(t, 0, 0.5, EASE_CAMERA);
  const seal = prog(t, 2.25, 2.85, EASE_EDITORIAL);

  return (
    <Curtain p={enter} from="left">
      <TactileBackdrop kind="lilac" t={t} duration={5.2}>
        <div style={{ position: 'absolute', left: 68, right: 68, top: 126 }}>
          <div
            className="hc-kicker"
            style={{ color: COLORS.mintDeep, fontSize: 15, marginBottom: 14 }}
          >
            03 / TEAM PEER REVIEW &amp; HUMAN VERDICT
          </div>
          <div
            className="hc-headline"
            style={{ fontSize: 72, color: COLORS.ink, marginBottom: 42 }}
          >
            AI synthesizes.
            <br />
            People decide.
          </div>

          {/* Peer Review Card */}
          <div
            className="hc-card"
            style={{
              padding: '30px 32px',
              marginBottom: 28,
              opacity: prog(t, 0.22, 0.8),
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 14,
              }}
            >
              <span
                style={{ fontSize: 19, fontWeight: 680, color: COLORS.ink }}
              >
                {SCENARIO.peerName} · {SCENARIO.peerRole}
              </span>
              <Pill tone="pass" style={{ fontWeight: 700 }}>
                ✓ Approved · +1
              </Pill>
            </div>
            <div
              style={{ fontSize: 19, color: COLORS.inkSoft, lineHeight: 1.5 }}
            >
              “Idempotency key &amp; monotonic rank guard are clean. Let&apos;s
              probe Postgres row locking in round 2.”
            </div>
          </div>

          {/* Finalized Human Packet & Managerial Handoff */}
          <div
            className="hc-card"
            style={{
              padding: '32px 34px',
              borderColor: seal > 0.2 ? COLORS.mintDeep : COLORS.border,
              boxShadow: '0 26px 70px rgba(33,20,38,0.14)',
              opacity: prog(t, 1.0, 1.6),
              transform: `translateY(${(1 - prog(t, 1.0, 1.6)) * 26}px)`,
            }}
          >
            <div
              className="hc-mono"
              style={{
                fontSize: 13,
                color: COLORS.mintDeep,
                fontWeight: 650,
                marginBottom: 12,
              }}
            >
              HUMAN REVIEW PACKET · HANDOFF READY
            </div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: COLORS.ink,
                marginBottom: 10,
              }}
            >
              Advance → Managerial Interview
            </div>
            <div
              style={{
                fontSize: 18,
                color: COLORS.inkSoft,
                lineHeight: 1.5,
                marginBottom: 26,
              }}
            >
              Transparent feedback published to {SCENARIO.candidateName}&apos;s
              portal ({SCENARIO.candidateCode}). Complete fit dossier &amp;
              round-2 probes handed to {SCENARIO.managerName}.
            </div>
            <div
              style={{
                padding: '18px 22px',
                borderRadius: 12,
                background: seal > 0.2 ? COLORS.plum : COLORS.paperSubtle,
                color: seal > 0.2 ? COLORS.onPlum : COLORS.muted,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 17,
                fontWeight: 650,
              }}
            >
              <span>● Finalized by {SCENARIO.evaluatorName}</span>
              <span
                className="hc-mono"
                style={{ fontSize: 13, color: COLORS.mint }}
              >
                IMMUTABLE
              </span>
            </div>
          </div>
        </div>
      </TactileBackdrop>
    </Curtain>
  );
}

function ReelAct5Finale() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const enter = prog(t, 0, 0.65, EASE_CAMERA);
  const mani1 = prog(t, 0.3, 1.05);
  const mani2 = prog(t, 0.78, 1.55);
  const lockIn = prog(t, 2.25, 3.05);

  return (
    <Curtain p={enter} from="top">
      <TactileBackdrop kind="vertical" t={t} duration={6.5} dim={0.1}>
        <div style={{ position: 'absolute', left: 76, right: 76, top: 240 }}>
          <div
            className="hc-headline"
            style={{ fontSize: 96, color: COLORS.onPlum }}
          >
            <RevealLine p={mani1}>Evidence informs.</RevealLine>
          </div>
          <div
            className="hc-headline"
            style={{ fontSize: 100, color: COLORS.mint, marginTop: 6 }}
          >
            <RevealLine p={mani2}>People decide.</RevealLine>
          </div>

          <div
            style={{
              marginTop: 120,
              opacity: lockIn,
              transform: `translateY(${lerp(24, 0, lockIn)}px)`,
            }}
          >
            <BrandWordmark size={62} dark />
            <div
              style={{
                fontSize: 34,
                color: COLORS.onPlumMuted,
                marginTop: 22,
                letterSpacing: '-0.03em',
              }}
            >
              Real work. In context.
            </div>
            <div
              style={{
                marginTop: 40,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 14,
                padding: '18px 30px',
                borderRadius: 12,
                background: COLORS.mint,
                color: COLORS.plum,
                fontSize: 25,
                fontWeight: 720,
              }}
            >
              <span>Request Early Access</span>
              <span>↗</span>
            </div>
            <div
              className="hc-mono"
              style={{ fontSize: 20, color: COLORS.onPlumMuted, marginTop: 22 }}
            >
              hirearchy.io/products/software
            </div>
          </div>
        </div>
      </TactileBackdrop>
    </Curtain>
  );
}

export function SocialReel9x16() {
  const { fps } = useVideoConfig();
  const f = (sec: number) => Math.round(sec * fps);

  return (
    <AbsoluteFill className="hc-root">
      <Sequence from={f(0)} durationInFrames={f(8.0)} name="Reel Hook">
        <ReelAct1Hook />
      </Sequence>
      <Sequence
        from={f(7.5)}
        durationInFrames={f(9.6)}
        premountFor={fps}
        name="Reel IDE"
      >
        <ReelAct2Ide />
      </Sequence>
      <Sequence
        from={f(16.5)}
        durationInFrames={f(7.1)}
        premountFor={fps}
        name="Reel Chronology & Advisory AI"
      >
        <ReelAct3ChronologyAdvisory />
      </Sequence>
      <Sequence
        from={f(23.0)}
        durationInFrames={f(5.3)}
        premountFor={fps}
        name="Reel Human Verdict"
      >
        <ReelAct4HumanAndHandoff />
      </Sequence>
      <Sequence
        from={f(27.7)}
        durationInFrames={f(6.3)}
        premountFor={fps}
        name="Reel Finale"
      >
        <ReelAct5Finale />
      </Sequence>
      <Audio src={staticFile('audio/reel-9x16.wav')} premountFor={fps} />
    </AbsoluteFill>
  );
}
