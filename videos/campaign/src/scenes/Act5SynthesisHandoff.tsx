import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import {
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
  EditorialHeader,
  Pill,
  TactileBackdrop,
} from '../components/Primitives';

/**
 * ACT V — AI SYNTHESIZES. PEOPLE DECIDE. + CONTINUITY (55.0s – 71.0s, local t: 0.0 – 16.0s)
 *   Part A (0.0 – 9.0s): Deep Plum Architectural Split
 *     - Left: Advisory AI Candidate Review (qualitative STRONG SIGNAL · ADVISORY ONLY,
 *             rationale, strengths, verification gaps, chronological timing insights)
 *     - Right: Finalized Immutable Human Review Packet (r210) — sovereign human decision & seal
 *   Part B (9.0 – 16.0s): Warm Daylight Cotton Paper — Closing the Loop
 *     - Left: Respectful Portable Candidate Portal (HRC-8492) with isolated private notes
 *     - Right: Advisory AI Managerial Performance & Fit Handoff Dossier
 */
export function Act5SynthesisHandoff() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const enter = prog(t, 0.0, 0.65, EASE_CAMERA);
  const advisoryIn = prog(t, 0.65, 1.5, EASE_EDITORIAL);
  const signalBloom = prog(t, 1.35, 2.15, EASE_EDITORIAL);
  const humanIn = prog(t, 3.1, 4.0, EASE_EDITORIAL);
  const sealLock = prog(t, 6.45, 7.1, EASE_EDITORIAL);

  // Part B (Portal + Managerial Handoff) starts at local t = 9.0s
  const handoffEnter = prog(t, 8.95, 9.65, EASE_CAMERA);
  const ht = t - 9.0;
  const portalIn = prog(ht, 0.4, 1.2);
  const dossierIn = prog(ht, 1.45, 2.35);
  const reqBars = prog(ht, 2.4, 3.8, EASE_CAMERA);

  const reqCoverage = [
    {
      label: 'Delivery ID Idempotency',
      status: 'Demonstrated',
      pct: 96,
      tone: 'pass' as const,
    },
    {
      label: 'Monotonic State Ordering',
      status: 'Demonstrated',
      pct: 94,
      tone: 'pass' as const,
    },
    {
      label: 'Test Verification Discipline',
      status: 'Demonstrated',
      pct: 88,
      tone: 'pass' as const,
    },
    {
      label: 'Distributed Concurrency Locks',
      status: 'Probe in Round 2',
      pct: 46,
      tone: 'neutral' as const,
    },
  ];

  return (
    <Curtain p={enter} from="bottom">
      <AbsoluteFill>
        {/* PART A: AI ADVICE vs. HUMAN SOVEREIGNTY (Deep Archival Plum) */}
        <TactileBackdrop kind="plum" t={t} duration={9.5}>
          <div
            style={{
              position: 'absolute',
              left: 108,
              right: 108,
              top: 56,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
            }}
          >
            <EditorialHeader
              kicker="05 / ADVISORY AI · HUMAN SOVEREIGNTY"
              lines={[
                <>
                  AI synthesizes.{' '}
                  <span style={{ color: COLORS.mint }}>People decide.</span>
                </>,
              ]}
              t={t}
              start={0.14}
              dark
              size={72}
            />
            <div style={{ opacity: prog(t, 0.35, 0.9), paddingBottom: 10 }}>
              <BrandWordmark size={22} dark />
            </div>
          </div>

          {/* ARCHITECTURAL SPLIT STAGE */}
          <div
            style={{
              position: 'absolute',
              left: 108,
              right: 108,
              top: 204,
              bottom: 64,
              display: 'grid',
              gridTemplateColumns: '1fr 2px 1fr',
              gap: 38,
              alignItems: 'stretch',
            }}
          >
            {/* LEFT PANEL: ADVISORY AI CANDIDATE REVIEW */}
            <div
              className="hc-card-dark"
              style={{
                padding: '30px 34px',
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
                opacity: advisoryIn,
                transform: `translateY(${(1 - advisoryIn) * 28}px)`,
                borderColor: 'rgba(187, 152, 244, 0.28)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 16,
                }}
              >
                <div>
                  <div
                    className="hc-mono"
                    style={{
                      fontSize: 11.5,
                      color: COLORS.purple,
                      letterSpacing: '0.14em',
                    }}
                  >
                    ADVISORY AI · CANDIDATE REVIEW
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 640,
                      color: COLORS.onPlum,
                      marginTop: 4,
                    }}
                  >
                    {KIMI_REVIEW.headline}
                  </div>
                </div>
              </div>

              {/* Qualitative Signal Banner (Zero numeric score!) */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                  padding: '20px 22px',
                  borderRadius: 14,
                  background: 'rgba(20, 11, 28, 0.68)',
                  border: '1px solid rgba(176, 240, 206, 0.28)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    transform: `scale(${lerp(0.95, 1, signalBloom)})`,
                    transformOrigin: 'left center',
                    opacity: Math.max(0.3, signalBloom),
                  }}
                >
                  <span
                    className="hc-mono"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 15px',
                      borderRadius: 999,
                      background: 'rgba(176, 240, 206, 0.16)',
                      border: '1px solid rgba(176, 240, 206, 0.42)',
                      color: COLORS.mint,
                      fontSize: 13.5,
                      fontWeight: 700,
                      letterSpacing: '0.09em',
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: COLORS.mint,
                      }}
                    />
                    STRONG SIGNAL · ADVISORY ONLY
                  </span>
                  <span
                    className="hc-mono"
                    style={{ fontSize: 12, color: COLORS.onPlumMuted }}
                  >
                    {KIMI_REVIEW.confidenceLabel}
                  </span>
                </div>
                <div
                  style={{ fontSize: 15, color: '#e5dcf0', lineHeight: 1.5 }}
                >
                  {KIMI_REVIEW.rationale}
                </div>
              </div>

              {/* Strengths & Verification Gaps */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 16,
                }}
              >
                <div
                  style={{
                    padding: '16px 18px',
                    borderRadius: 12,
                    background: 'rgba(176, 240, 206, 0.06)',
                    border: '1px solid rgba(176, 240, 206, 0.16)',
                  }}
                >
                  <div
                    className="hc-mono"
                    style={{
                      fontSize: 11,
                      color: COLORS.mint,
                      letterSpacing: '0.1em',
                      marginBottom: 10,
                    }}
                  >
                    OBSERVED STRENGTHS
                  </div>
                  {KIMI_REVIEW.strengths.map((s) => (
                    <div
                      key={s}
                      style={{
                        fontSize: 13.8,
                        color: '#ebe3f2',
                        lineHeight: 1.4,
                        marginBottom: 7,
                        display: 'flex',
                        gap: 8,
                      }}
                    >
                      <span style={{ color: COLORS.mint }}>+</span>
                      <span>{s}</span>
                    </div>
                  ))}
                </div>
                <div
                  style={{
                    padding: '16px 18px',
                    borderRadius: 12,
                    background: 'rgba(255, 155, 136, 0.06)',
                    border: '1px solid rgba(255, 155, 136, 0.18)',
                  }}
                >
                  <div
                    className="hc-mono"
                    style={{
                      fontSize: 11,
                      color: COLORS.coral,
                      letterSpacing: '0.1em',
                      marginBottom: 10,
                    }}
                  >
                    VERIFICATION GAPS
                  </div>
                  {KIMI_REVIEW.weaknesses.map((w) => (
                    <div
                      key={w}
                      style={{
                        fontSize: 13.8,
                        color: '#ebe3f2',
                        lineHeight: 1.4,
                        marginBottom: 8,
                        display: 'flex',
                        gap: 8,
                      }}
                    >
                      <span style={{ color: COLORS.coral }}>!</span>
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Requirement Evidence Breakdown (Live Kimi structured synthesis) */}
              <div
                style={{
                  padding: '14px 18px',
                  borderRadius: 12,
                  background: 'rgba(20, 11, 28, 0.48)',
                  border: `1px solid ${COLORS.plumLine}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 9,
                }}
              >
                <div
                  className="hc-mono"
                  style={{
                    fontSize: 11,
                    color: COLORS.purple,
                    letterSpacing: '0.1em',
                  }}
                >
                  REQUIREMENT EVIDENCE BREAKDOWN
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <Pill tone="darkMint">Delivery ID Dedupe · Demonstrated</Pill>
                  <Pill tone="darkMint">Monotonic Rank · Demonstrated</Pill>
                  <Pill
                    tone="darkMint"
                    style={{
                      background: 'rgba(255,155,136,0.12)',
                      color: COLORS.coral,
                      borderColor: 'rgba(255,155,136,0.32)',
                    }}
                  >
                    Concurrent Locks · Probe Round 2
                  </Pill>
                </div>
              </div>

              {/* Timing & Workflow Deltas */}
              <div
                style={{
                  padding: '16px 18px',
                  borderRadius: 12,
                  background: 'rgba(20, 11, 28, 0.62)',
                  border: `1px solid ${COLORS.plumLine}`,
                  marginTop: 'auto',
                }}
              >
                <div
                  className="hc-mono"
                  style={{
                    fontSize: 11,
                    color: COLORS.onPlumMuted,
                    letterSpacing: '0.1em',
                    marginBottom: 8,
                  }}
                >
                  CHRONOLOGICAL TIMING &amp; WORKFLOW (Δ)
                </div>
                {KIMI_REVIEW.timingInsights.map((ti) => (
                  <div
                    key={ti}
                    className="hc-mono"
                    style={{
                      fontSize: 13.2,
                      color: '#e4d9ee',
                      lineHeight: 1.55,
                    }}
                  >
                    → {ti}
                  </div>
                ))}
              </div>
            </div>

            {/* ARCHITECTURAL SEPARATION RULE */}
            <div
              style={{
                width: 2,
                background:
                  'linear-gradient(180deg, rgba(176,240,206,0) 0%, rgba(176,240,206,0.48) 35%, rgba(176,240,206,0.48) 65%, rgba(176,240,206,0) 100%)',
                opacity: humanIn,
              }}
            />

            {/* RIGHT PANEL: IMMUTABLE HUMAN-OWNED REVIEW PACKET (r210) */}
            <div
              className="hc-card"
              style={{
                padding: '30px 34px',
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
                opacity: humanIn,
                transform: `translateY(${(1 - humanIn) * 28}px)`,
                borderColor: sealLock > 0.3 ? COLORS.mintStrong : COLORS.border,
                boxShadow:
                  sealLock > 0.3
                    ? '0 32px 96px rgba(6, 2, 12, 0.55), 0 0 0 2px rgba(176, 240, 206, 0.55)'
                    : '0 32px 90px rgba(6, 2, 12, 0.45)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div
                    className="hc-mono"
                    style={{
                      fontSize: 11.5,
                      color: COLORS.mintDeep,
                      letterSpacing: '0.14em',
                      fontWeight: 650,
                    }}
                  >
                    HUMAN REVIEW PACKET · AUTHORITATIVE RECORD
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 680,
                      color: COLORS.ink,
                      marginTop: 4,
                    }}
                  >
                    {SCENARIO.candidateName} · {SCENARIO.role}
                  </div>
                </div>
                <Pill tone="plum">{SCENARIO.candidateCode}</Pill>
              </div>

              {/* Grounded Citations */}
              <div
                style={{
                  padding: '16px 20px',
                  borderRadius: 12,
                  background: COLORS.paper,
                  border: `1px solid ${COLORS.border}`,
                }}
              >
                <div
                  className="hc-mono"
                  style={{
                    fontSize: 11,
                    color: COLORS.muted,
                    letterSpacing: '0.1em',
                    marginBottom: 10,
                  }}
                >
                  GROUNDED EVIDENCE &amp; PEER CITATIONS
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 9,
                    fontSize: 14.2,
                    color: COLORS.ink,
                  }}
                >
                  <div>
                    <strong style={{ color: COLORS.mintDeep }}>
                      [Diff v2]
                    </strong>{' '}
                    Clean{' '}
                    <span className="hc-mono" style={{ fontSize: 13 }}>
                      delivery_id
                    </span>{' '}
                    dedupe &amp; monotonic{' '}
                    <span className="hc-mono" style={{ fontSize: 13 }}>
                      STATUS_RANK
                    </span>{' '}
                    guard; 4/4 pytest verified.
                  </div>
                  <div>
                    <strong style={{ color: COLORS.mintDeep }}>
                      [Peer +1]
                    </strong>{' '}
                    Jordan Lee approved; aligned to probe distributed DB locks
                    in Round 2.
                  </div>
                </div>
              </div>

              {/* Evaluator Written Summary */}
              <div
                style={{
                  padding: '16px 20px',
                  borderRadius: 12,
                  background: COLORS.paperElevated,
                  border: `1px solid ${COLORS.border}`,
                }}
              >
                <div
                  className="hc-mono"
                  style={{
                    fontSize: 11,
                    color: COLORS.muted,
                    letterSpacing: '0.1em',
                    marginBottom: 8,
                  }}
                >
                  EVALUATOR SUMMARY · {SCENARIO.evaluatorName.toUpperCase()}
                </div>
                <div
                  style={{
                    fontSize: 16,
                    color: COLORS.ink,
                    lineHeight: 1.5,
                    fontWeight: 500,
                  }}
                >
                  “Strong engineering instincts under ambiguity. Used AI once to
                  confirm idempotency semantics rather than outsource thinking.
                  Advance directly to Managerial Interview.”
                </div>
              </div>

              {/* Outcome Decision Bar */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 12,
                }}
              >
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: 11,
                    background: '#ecfdf3',
                    border: '1.5px solid #2f6f54',
                  }}
                >
                  <div
                    className="hc-mono"
                    style={{
                      fontSize: 10.5,
                      color: COLORS.mintDeep,
                      fontWeight: 650,
                    }}
                  >
                    HUMAN DECISION
                  </div>
                  <div
                    style={{
                      fontSize: 17,
                      fontWeight: 700,
                      color: COLORS.pass,
                      marginTop: 3,
                    }}
                  >
                    ✓ Advance Candidate
                  </div>
                </div>
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: 11,
                    background: COLORS.paperSubtle,
                    border: `1px solid ${COLORS.border}`,
                  }}
                >
                  <div
                    className="hc-mono"
                    style={{ fontSize: 10.5, color: COLORS.muted }}
                  >
                    NEXT STAGE &amp; HANDOFF
                  </div>
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 650,
                      color: COLORS.ink,
                      marginTop: 3,
                    }}
                  >
                    Managerial · {SCENARIO.managerName}
                  </div>
                </div>
              </div>

              {/* Candidate Feedback Separation Notice */}
              <div
                style={{
                  padding: '14px 18px',
                  borderRadius: 11,
                  background: '#f7f3fa',
                  border: '1px solid #dfd3ea',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div
                  style={{
                    fontSize: 13.8,
                    color: COLORS.inkSoft,
                    lineHeight: 1.4,
                  }}
                >
                  <strong style={{ color: COLORS.ink }}>
                    Published to candidate:
                  </strong>{' '}
                  Strengths &amp; next-stage invitation.
                  <br />
                  <strong style={{ color: COLORS.ink }}>
                    Team-only private:
                  </strong>{' '}
                  Advisory briefs, peer notes &amp; interview probes.
                </div>
                <Pill tone="lilac">Separated</Pill>
              </div>

              {/* Immutable Seal Banner */}
              <div
                style={{
                  marginTop: 'auto',
                  padding: '16px 20px',
                  borderRadius: 12,
                  background: sealLock > 0.2 ? COLORS.plum : COLORS.paperSubtle,
                  color: sealLock > 0.2 ? COLORS.onPlum : COLORS.muted,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  transform: `scale(${lerp(0.98, 1, sealLock)})`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span
                    style={{
                      width: 11,
                      height: 11,
                      borderRadius: '50%',
                      background:
                        sealLock > 0.2 ? COLORS.mint : COLORS.borderStrong,
                      boxShadow:
                        sealLock > 0.2
                          ? '0 0 12px rgba(176,240,206,0.8)'
                          : 'none',
                    }}
                  />
                  <span style={{ fontSize: 15.5, fontWeight: 640 }}>
                    {sealLock > 0.2
                      ? 'Finalized by Sam Rivera · Immutable Record'
                      : 'Ready for human sign-off…'}
                  </span>
                </div>
                <span
                  className="hc-mono"
                  style={{
                    fontSize: 12,
                    color: sealLock > 0.2 ? COLORS.mint : COLORS.muted,
                  }}
                >
                  NO AUTO-REJECT
                </span>
              </div>
            </div>
          </div>
        </TactileBackdrop>

        {/* PART B: RESPECTFUL CANDIDATE PORTAL & MANAGERIAL HANDOFF (Warm Cotton Daylight, t >= 8.95s) */}
        {t >= 8.9 ? (
          <Curtain p={handoffEnter} from="right">
            <TactileBackdrop kind="paper" t={ht} duration={7.5}>
              <EditorialHeader
                kicker="06 / CANDIDATE PORTAL & MANAGERIAL HANDOFF"
                lines={['Respect the candidate. Brief the room.']}
                t={ht}
                start={0.14}
                size={70}
                style={{ position: 'absolute', left: 108, top: 64 }}
              />

              <div
                className="hc-subcopy"
                style={{
                  position: 'absolute',
                  left: 112,
                  top: 184,
                  fontSize: 22,
                  color: COLORS.inkSoft,
                  opacity: prog(ht, 0.45, 1.05),
                }}
              >
                Candidates get transparent feedback in one portable portal. The
                next interviewer walks in with the complete dossier.
              </div>

              <div
                style={{
                  position: 'absolute',
                  left: 108,
                  right: 108,
                  top: 256,
                  bottom: 66,
                  display: 'grid',
                  gridTemplateColumns: '0.88fr 1.12fr',
                  gap: 34,
                }}
              >
                {/* LEFT: PORTABLE CANDIDATE PORTAL (Dark Plum Card for high-craft contrast!) */}
                <div
                  className="hc-window-dark"
                  style={{
                    background: COLORS.plum,
                    padding: '32px 34px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 20,
                    opacity: portalIn,
                    transform: `translateY(${(1 - portalIn) * 26}px)`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <BrandWordmark size={20} dark product="Candidate Portal" />
                    <span
                      className="hc-mono"
                      style={{ fontSize: 12.5, color: COLORS.mint }}
                    >
                      {SCENARIO.candidateCode}
                    </span>
                  </div>

                  <div
                    style={{
                      padding: '22px 24px',
                      borderRadius: 14,
                      background: '#2a1b36',
                      border: '1px solid rgba(176, 240, 206, 0.28)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 10,
                      }}
                    >
                      <span
                        className="hc-mono"
                        style={{ fontSize: 11.5, color: COLORS.onPlumMuted }}
                      >
                        NORTHLINE ENGINEERING
                      </span>
                      <Pill tone="darkMint" style={{ fontWeight: 700 }}>
                        Accepted
                      </Pill>
                    </div>
                    <div
                      style={{
                        fontSize: 25,
                        fontWeight: 660,
                        color: COLORS.onPlum,
                      }}
                    >
                      {SCENARIO.title}
                    </div>
                    <div
                      style={{
                        fontSize: 16,
                        color: COLORS.mint,
                        marginTop: 8,
                        fontWeight: 560,
                      }}
                    >
                      Next step: Managerial Interview with{' '}
                      {SCENARIO.managerName}
                    </div>
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
                        padding: '16px 18px',
                        borderRadius: 12,
                        background: 'rgba(176, 240, 206, 0.08)',
                        border: '1px solid rgba(176, 240, 206, 0.2)',
                      }}
                    >
                      <div
                        className="hc-mono"
                        style={{
                          fontSize: 11,
                          color: COLORS.mint,
                          marginBottom: 8,
                        }}
                      >
                        STRENGTHS SHARED
                      </div>
                      <div
                        style={{
                          fontSize: 14.5,
                          color: COLORS.onPlum,
                          lineHeight: 1.48,
                        }}
                      >
                        Clean idempotency design, methodical test-first
                        debugging, and clear state-machine invariants.
                      </div>
                    </div>
                    <div
                      style={{
                        padding: '16px 18px',
                        borderRadius: 12,
                        background: 'rgba(245, 239, 230, 0.06)',
                        border: `1px solid ${COLORS.plumLine}`,
                      }}
                    >
                      <div
                        className="hc-mono"
                        style={{
                          fontSize: 11,
                          color: COLORS.onPlumMuted,
                          marginBottom: 8,
                        }}
                      >
                        TOPIC FOR NEXT ROUND
                      </div>
                      <div
                        style={{
                          fontSize: 14.5,
                          color: COLORS.onPlumMuted,
                          lineHeight: 1.48,
                        }}
                      >
                        We&apos;d love to discuss distributed transaction
                        atomicity and crash recovery at scale.
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      marginTop: 'auto',
                      padding: '13px 16px',
                      borderRadius: 10,
                      background: 'rgba(20, 11, 28, 0.55)',
                      border: `1px solid ${COLORS.plumLine}`,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 13.5,
                      color: COLORS.onPlumMuted,
                    }}
                  >
                    <span>
                      Internal peer notes &amp; advisory briefs remain strictly
                      private
                    </span>
                    <span
                      className="hc-mono"
                      style={{ color: COLORS.mint, fontSize: 11.5 }}
                    >
                      ISOLATED
                    </span>
                  </div>
                </div>

                {/* RIGHT: MANAGERIAL HANDOFF DOSSIER & KIMI PERFORMANCE FIT REPORT */}
                <div
                  className="hc-card"
                  style={{
                    padding: '32px 34px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 18,
                    opacity: dossierIn,
                    transform: `translateY(${(1 - dossierIn) * 26}px)`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                    }}
                  >
                    <div>
                      <div
                        className="hc-mono"
                        style={{
                          fontSize: 11.5,
                          color: COLORS.mintDeep,
                          letterSpacing: '0.12em',
                          fontWeight: 650,
                        }}
                      >
                        MANAGERIAL HANDOFF DOSSIER · ADVISORY AI BRIEF
                      </div>
                      <div
                        style={{
                          fontSize: 24,
                          fontWeight: 680,
                          color: COLORS.ink,
                          marginTop: 4,
                        }}
                      >
                        {KIMI_REVIEW.fitHeadline}
                      </div>
                    </div>
                    <Pill
                      tone="pass"
                      style={{ fontWeight: 700, flexShrink: 0 }}
                    >
                      Strong Fit
                    </Pill>
                  </div>

                  {/* Candidate Identity & Stack Strip */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '14px 18px',
                      borderRadius: 12,
                      background: COLORS.paperSubtle,
                      border: `1px solid ${COLORS.border}`,
                    }}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 14 }}
                    >
                      <div
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: '50%',
                          background: COLORS.plum,
                          color: COLORS.mint,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 700,
                          fontSize: 15,
                        }}
                      >
                        EV
                      </div>
                      <div>
                        <div
                          style={{
                            fontSize: 16,
                            fontWeight: 680,
                            color: COLORS.ink,
                          }}
                        >
                          {SCENARIO.candidateName}{' '}
                          <span
                            className="hc-mono"
                            style={{
                              fontSize: 12.5,
                              color: COLORS.muted,
                              fontWeight: 500,
                            }}
                          >
                            · {SCENARIO.candidateCode}
                          </span>
                        </div>
                        <div style={{ fontSize: 13, color: COLORS.muted }}>
                          {SCENARIO.role} · {SCENARIO.level} · Decided by{' '}
                          {SCENARIO.evaluatorName}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Pill tone="neutral">Python</Pill>
                      <Pill tone="mint">Idempotency</Pill>
                    </div>
                  </div>

                  {/* Requirement Coverage Matrix */}
                  <div
                    style={{
                      padding: '18px 20px',
                      borderRadius: 12,
                      background: COLORS.paper,
                      border: `1px solid ${COLORS.border}`,
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '14px 22px',
                    }}
                  >
                    {reqCoverage.map((req) => (
                      <div key={req.label}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 13.5,
                            marginBottom: 6,
                          }}
                        >
                          <span style={{ fontWeight: 620, color: COLORS.ink }}>
                            {req.label}
                          </span>
                          <span
                            className="hc-mono"
                            style={{
                              fontSize: 11.5,
                              color:
                                req.tone === 'pass'
                                  ? COLORS.pass
                                  : COLORS.muted,
                              fontWeight: 600,
                            }}
                          >
                            {req.status}
                          </span>
                        </div>
                        <div
                          style={{
                            height: 6,
                            borderRadius: 999,
                            background: '#e5ddd3',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${req.pct * reqBars}%`,
                              borderRadius: 999,
                              background:
                                req.tone === 'pass'
                                  ? COLORS.mintDeep
                                  : COLORS.purple,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Real Kimi Tailored Round-2 Questions */}
                  <div
                    style={{
                      padding: '18px 20px',
                      borderRadius: 12,
                      background: '#faf7fc',
                      border: '1px solid #dfd3ea',
                      flex: 1,
                    }}
                  >
                    <div
                      className="hc-mono"
                      style={{
                        fontSize: 11,
                        color: COLORS.plum,
                        letterSpacing: '0.1em',
                        fontWeight: 650,
                        marginBottom: 10,
                      }}
                    >
                      TAILORED ROUND-2 INTERVIEW PROBES FOR{' '}
                      {SCENARIO.managerName.toUpperCase()}
                    </div>
                    {KIMI_REVIEW.nextInterviewQuestions.map((q, idx) => (
                      <div
                        key={q}
                        style={{
                          display: 'flex',
                          gap: 12,
                          fontSize: 15.5,
                          color: COLORS.ink,
                          lineHeight: 1.48,
                          marginBottom: idx === 0 ? 10 : 0,
                          fontWeight: 520,
                        }}
                      >
                        <span
                          className="hc-mono"
                          style={{ color: COLORS.mintDeep, fontWeight: 700 }}
                        >
                          0{idx + 1}
                        </span>
                        <span>“{q}”</span>
                      </div>
                    ))}
                  </div>

                  {/* Direct 1-click link back to immutable evidence */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontSize: 14, color: COLORS.muted }}>
                      Zero context lost between assessment and final round.
                    </span>
                    <span
                      style={{
                        padding: '10px 18px',
                        borderRadius: 9,
                        background: COLORS.plum,
                        color: COLORS.onPlum,
                        fontSize: 14,
                        fontWeight: 620,
                      }}
                    >
                      Open Full Evidence Reconstruction ↗
                    </span>
                  </div>
                </div>
              </div>
            </TactileBackdrop>
          </Curtain>
        ) : null}
      </AbsoluteFill>
    </Curtain>
  );
}
