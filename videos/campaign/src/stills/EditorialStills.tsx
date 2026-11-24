import { AbsoluteFill } from 'remotion';
import {
  CHRONOLOGY_EVENTS,
  CODE_ADDED_DEDUPE,
  CODE_ADDED_GUARD,
  CODE_FOOTER_LINES,
  COLORS,
  KIMI_REVIEW,
  SCENARIO,
} from '../tokens';
import {
  BrandWordmark,
  Pill,
  PythonLine,
  TactileBackdrop,
} from '../components/Primitives';
import '../campaign.css';

/**
 * STILL 01 — MANIFESTO HERO POSTER (2400x1350, 16:9)
 */
export function Still01Manifesto() {
  return (
    <AbsoluteFill className="hc-root">
      <TactileBackdrop kind="opening" t={4} duration={10} dim={0.12}>
        <div style={{ position: 'absolute', left: 154, top: 128 }}>
          <BrandWordmark size={50} dark />
        </div>

        <div style={{ position: 'absolute', left: 154, top: 360, width: 1080 }}>
          <div className="hc-kicker" style={{ color: COLORS.mint, fontSize: 19, marginBottom: 26 }}>
            HIREARCHY SOFTWARE · LAUNCH CAMPAIGN
          </div>
          <div className="hc-headline" style={{ fontSize: 126, color: COLORS.onPlumMuted }}>
            The answer
            <br />
            is cheap.
          </div>
          <div className="hc-headline" style={{ fontSize: 134, color: COLORS.onPlum, marginTop: 18 }}>
            The work is
            <br />
            everything<span style={{ color: COLORS.mint }}>.</span>
          </div>
        </div>

        <div
          style={{
            position: 'absolute',
            left: 154,
            right: 154,
            bottom: 108,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderTop: '1px solid rgba(245,239,230,0.16)',
            paddingTop: 30,
          }}
        >
          <div style={{ fontSize: 27, color: COLORS.onPlumMuted, letterSpacing: '-0.02em' }}>
            Real repositories. Observable chronology. Sovereign human decisions.
          </div>
          <div className="hc-mono" style={{ fontSize: 22, color: COLORS.mint }}>
            hirearchy.io/products/software
          </div>
        </div>
      </TactileBackdrop>
    </AbsoluteFill>
  );
}

/**
 * STILL 02 — TWO 100%s EDITORIAL CONTRAST CARD (1600x2000, 4:5 LinkedIn/X)
 */
export function Still02Two100s() {
  return (
    <AbsoluteFill className="hc-root">
      <TactileBackdrop kind="paper" t={2} duration={10}>
        <div style={{ position: 'absolute', inset: 0, padding: '104px 98px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 48 }}>
            <BrandWordmark size={38} dark={false} />
            <span className="hc-mono" style={{ fontSize: 17, color: COLORS.mintDeep, fontWeight: 650, letterSpacing: '0.12em' }}>
              EVIDENCE OVER IMPRESSIONS
            </span>
          </div>

          <div className="hc-headline" style={{ fontSize: 94, color: COLORS.ink, marginBottom: 20 }}>
            Two candidates.
            <br />
            Identical 100% score.
          </div>
          <div className="hc-subcopy" style={{ fontSize: 31, color: COLORS.inkSoft, marginBottom: 48 }}>
            AI made final answers cheap. Only the observable trajectory shows who can actually engineer.
          </div>

          {/* Candidate A */}
          <div
            className="hc-card"
            style={{
              padding: '42px 46px',
              marginBottom: 32,
              borderColor: COLORS.failBorder,
              opacity: 0.86,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <div>
                <span className="hc-kicker" style={{ fontSize: 17, color: COLORS.muted }}>CANDIDATE A · 4 / 4 PASSED</span>
                <div style={{ fontSize: 21, color: COLORS.muted, marginTop: 6 }}>
                  Identical passing code. Zero recorded debugging signal.
                </div>
              </div>
              <span className="hc-tabular" style={{ fontSize: 78, fontWeight: 700, color: COLORS.muted, lineHeight: 0.9 }}>100%</span>
            </div>
            <div style={{ height: 9, borderRadius: 999, background: '#fee2e2', marginBottom: 20, overflow: 'hidden' }}>
              <div style={{ width: '11%', height: '100%', background: COLORS.fail, marginLeft: 'auto' }} />
            </div>
            <div className="hc-mono" style={{ fontSize: 20, color: COLORS.fail, fontWeight: 650 }}>
              00:41 elapsed · Single bulk paste at 00:39 · 0 test iterations
            </div>
          </div>

          {/* Candidate B */}
          <div
            className="hc-card"
            style={{
              padding: '44px 46px',
              borderColor: COLORS.mintDeep,
              borderWidth: 2,
              boxShadow: '0 32px 84px rgba(47, 111, 84, 0.16)',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 26 }}>
              <div>
                <span className="hc-kicker" style={{ fontSize: 17, color: COLORS.mintDeep }}>CANDIDATE B · 4 / 4 PASSED</span>
                <div style={{ fontSize: 22, color: COLORS.ink, fontWeight: 560, marginTop: 6 }}>
                  14m 22s observable chronology · 6 verified events
                </div>
              </div>
              <span className="hc-tabular" style={{ fontSize: 78, fontWeight: 720, color: COLORS.mintDeep, lineHeight: 0.9 }}>100%</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 15, flex: 1, justifyContent: 'space-between' }}>
              {CHRONOLOGY_EVENTS.slice(1).map((ev) => (
                <div
                  key={ev.seq}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '17px 22px',
                    borderRadius: 12,
                    background:
                      ev.kind === 'pass'
                        ? '#ecfdf3'
                        : ev.kind === 'fail'
                          ? '#fef7f7'
                          : COLORS.paper,
                    border: `1px solid ${
                      ev.kind === 'pass'
                        ? '#bbf7d0'
                        : ev.kind === 'fail'
                          ? '#fecaca'
                          : COLORS.border
                    }`,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 660, color: COLORS.ink }}>{ev.title}</div>
                    <div style={{ fontSize: 17.5, color: COLORS.muted, marginTop: 4 }}>{ev.detail}</div>
                  </div>
                  <span
                    className="hc-mono"
                    style={{
                      fontSize: 16.5,
                      color: ev.kind === 'fail' ? COLORS.fail : COLORS.mintDeep,
                      fontWeight: 660,
                      flexShrink: 0,
                      marginLeft: 16,
                    }}
                  >
                    +{ev.offset} · {ev.delta}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              marginTop: 38,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingTop: 28,
              borderTop: `1px solid ${COLORS.border}`,
            }}
          >
            <span style={{ fontSize: 25, fontWeight: 620, color: COLORS.ink }}>
              See how the mind moved — not just the final string.
            </span>
            <span className="hc-mono" style={{ fontSize: 21, color: COLORS.mintDeep, fontWeight: 650 }}>
              hirearchy.io
            </span>
          </div>
        </div>
      </TactileBackdrop>
    </AbsoluteFill>
  );
}

/**
 * STILL 03 — AUTHENTIC IDE · ZERO SPYWARE (1600x2000, 4:5)
 */
export function Still03AuthenticIde() {
  const codeLines = [
    'def handle_webhook(ledger: MerchantLedger, event: WebhookEvent) -> str:',
    ...CODE_ADDED_DEDUPE,
    '    payment = ledger.get_or_create(event["payment_id"], event["amount_cents"])',
    '    target = EVENT_TO_STATUS.get(event["event_type"])',
    ...CODE_ADDED_GUARD,
    ...CODE_FOOTER_LINES,
  ];
  return (
    <AbsoluteFill className="hc-root">
      <TactileBackdrop kind="plum" t={2} duration={10}>
        <div style={{ position: 'absolute', inset: 0, padding: '104px 92px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 44 }}>
            <BrandWordmark size={38} dark />
            <Pill tone="darkMint" style={{ fontSize: 16, padding: '8px 16px' }}>ZERO SURVEILLANCE</Pill>
          </div>

          <div className="hc-headline" style={{ fontSize: 92, color: COLORS.onPlum, marginBottom: 20 }}>
            Real repository.
            <br />
            <span style={{ color: COLORS.mint }}>Neutral logged AI.</span>
          </div>
          <div className="hc-subcopy" style={{ fontSize: 29, color: COLORS.onPlumMuted, marginBottom: 42 }}>
            No webcam spyware. No tab-switch traps. Candidates work in an isolated Docker IDE with real tests and transparent AI assistance.
          </div>

          <div className="hc-window-dark" style={{ background: '#140b1d', flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                padding: '20px 28px',
                background: COLORS.plum,
                borderBottom: `1px solid ${COLORS.plumLine}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span className="hc-mono" style={{ fontSize: 19, color: COLORS.mint, fontWeight: 650 }}>
                src/webhook_handler.py · v2
              </span>
              <div style={{ display: 'flex', gap: 10 }}>
                <Pill tone="darkMint">Docker Sandbox: Active</Pill>
                <Pill tone="darkMint" style={{ background: 'rgba(187,152,244,0.16)', color: COLORS.purple, borderColor: 'rgba(187,152,244,0.34)' }}>
                  AI: Logged &amp; Neutral
                </Pill>
              </div>
            </div>

            <div className="hc-mono" style={{ padding: '24px 24px', fontSize: 19.5, lineHeight: 1.72, flex: 1 }}>
              {codeLines.map((line, i) => {
                const isAdded = (i >= 1 && i <= 4) || (i >= 7 && i <= 9);
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      gap: 18,
                      padding: '1px 12px',
                      background: isAdded ? 'rgba(176,240,206,0.09)' : 'transparent',
                      borderLeft: isAdded ? `3px solid ${COLORS.mint}` : '3px solid transparent',
                    }}
                  >
                    <span style={{ color: COLORS.onPlumFaint, width: 38, textAlign: 'right' }}>{112 + i}</span>
                    <span style={{ whiteSpace: 'pre-wrap' }}>
                      <PythonLine text={line} theme="dark" />
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Inline Logged Workspace AI Proof */}
            <div
              style={{
                margin: '0 26px 22px',
                padding: '18px 22px',
                borderRadius: 12,
                background: 'rgba(187, 152, 244, 0.09)',
                border: '1px solid rgba(187, 152, 244, 0.28)',
              }}
            >
              <div className="hc-mono" style={{ fontSize: 13.5, color: COLORS.purple, marginBottom: 6 }}>
                RECORDED WORKSPACE AI TURN #1 · +06:48 · NEUTRAL CONTEXT
              </div>
              <div style={{ fontSize: 19, color: COLORS.onPlum, lineHeight: 1.45 }}>
                “Should an out-of-order <span className="hc-mono" style={{ fontSize: 17 }}>payment.authorized</span> after settled return silently or raise?” → <span style={{ color: COLORS.mint }}>Confirmed monotonic return to prevent retry storms.</span>
              </div>
            </div>

            <div
              className="hc-mono"
              style={{
                padding: '24px 32px',
                background: '#0f0716',
                borderTop: `1px solid ${COLORS.plumLine}`,
                fontSize: 19,
                lineHeight: 1.72,
              }}
            >
              <div style={{ color: COLORS.onPlumMuted }}>
                <span style={{ color: COLORS.mint }}>$</span> pytest tests/test_webhooks.py -q
              </div>
              <div style={{ color: COLORS.passDark }}>
                ✓ test_duplicate_delivery_is_idempotent .................. PASSED
                <br />✓ test_out_of_order_authorized_after_settled ............. PASSED
                <br />✓ 4 passed in 0.14s · Saved to immutable chronology
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: 36,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 23, color: COLORS.onPlumMuted }}>
              Built so senior engineers feel respected — and reviewers see the truth.
            </span>
            <span className="hc-mono" style={{ fontSize: 20, color: COLORS.mint }}>
              hirearchy.io
            </span>
          </div>
        </div>
      </TactileBackdrop>
    </AbsoluteFill>
  );
}

/**
 * STILL 04 — AI SYNTHESIZES. PEOPLE DECIDE. (1600x2000, 4:5)
 */
export function Still04AiAndHuman() {
  return (
    <AbsoluteFill className="hc-root">
      <TactileBackdrop kind="plum" t={2} duration={10}>
        <div style={{ position: 'absolute', inset: 0, padding: '104px 92px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 42 }}>
            <BrandWordmark size={38} dark />
            <span className="hc-mono" style={{ fontSize: 16, color: COLORS.mint, letterSpacing: '0.12em' }}>
              ADVISORY AI · HUMAN SOVEREIGNTY
            </span>
          </div>

          <div className="hc-headline" style={{ fontSize: 94, color: COLORS.onPlum, marginBottom: 38 }}>
            AI synthesizes.
            <br />
            <span style={{ color: COLORS.mint }}>People decide.</span>
          </div>

          {/* Advisory AI Panel (Qualitative Signal — Zero numeric score!) */}
          <div
            className="hc-card-dark"
            style={{
              padding: '34px 38px',
              marginBottom: 30,
              borderColor: 'rgba(187,152,244,0.34)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <span className="hc-mono" style={{ fontSize: 15, color: COLORS.purple, letterSpacing: '0.12em' }}>
                ADVISORY AI · CANDIDATE REVIEW
              </span>
              <span className="hc-mono" style={{ fontSize: 14, color: COLORS.onPlumMuted }}>
                {KIMI_REVIEW.confidenceLabel}
              </span>
            </div>
            <div style={{ marginBottom: 18 }}>
              <span
                className="hc-mono"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 11,
                  padding: '10px 20px',
                  borderRadius: 999,
                  background: 'rgba(176, 240, 206, 0.16)',
                  border: '1px solid rgba(176, 240, 206, 0.44)',
                  color: COLORS.mint,
                  fontSize: 18,
                  fontWeight: 720,
                  letterSpacing: '0.09em',
                }}
              >
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: COLORS.mint }} />
                STRONG SIGNAL · ADVISORY ONLY
              </span>
            </div>
            <div style={{ fontSize: 22, color: COLORS.onPlum, lineHeight: 1.48, marginBottom: 22 }}>
              {KIMI_REVIEW.rationale}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div style={{ padding: '14px 18px', borderRadius: 10, background: 'rgba(176,240,206,0.07)', border: '1px solid rgba(176,240,206,0.18)' }}>
                <div className="hc-mono" style={{ fontSize: 12.5, color: COLORS.mint, marginBottom: 6 }}>STRENGTHS</div>
                <div style={{ fontSize: 16.5, color: COLORS.onPlum, lineHeight: 1.42 }}>
                  + {KIMI_REVIEW.strengths[0]}
                  <br />+ {KIMI_REVIEW.strengths[1]}
                </div>
              </div>
              <div style={{ padding: '14px 18px', borderRadius: 10, background: 'rgba(255,155,136,0.07)', border: '1px solid rgba(255,155,136,0.18)' }}>
                <div className="hc-mono" style={{ fontSize: 12.5, color: COLORS.coral, marginBottom: 6 }}>VERIFICATION GAPS</div>
                <div style={{ fontSize: 16.5, color: COLORS.onPlum, lineHeight: 1.42 }}>
                  ! {KIMI_REVIEW.weaknesses[0]}
                </div>
              </div>
            </div>
            <div className="hc-mono" style={{ fontSize: 16, color: COLORS.mint }}>
              → {KIMI_REVIEW.timingInsights[0]}
              <br />→ {KIMI_REVIEW.timingInsights[1]}
            </div>
          </div>

          {/* Immutable Human Review Packet */}
          <div className="hc-card" style={{ padding: '38px 42px', flex: 1, display: 'flex', flexDirection: 'column', gap: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="hc-mono" style={{ fontSize: 15, color: COLORS.mintDeep, fontWeight: 700, letterSpacing: '0.12em' }}>
                FINALIZED HUMAN REVIEW PACKET · IMMUTABLE
              </span>
              <Pill tone="pass" style={{ fontSize: 16, padding: '7px 14px', fontWeight: 700 }}>
                ✓ Advance → Managerial
              </Pill>
            </div>

            <div style={{ fontSize: 24, color: COLORS.ink, lineHeight: 1.48, fontWeight: 560 }}>
              “Strong engineering instincts under ambiguity. Used AI once to confirm idempotency semantics rather than outsource thinking. Handed off with tailored concurrency probes.”
            </div>

            {/* Cited Evidence & Peer Review */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ padding: '18px 20px', borderRadius: 12, background: '#f5fbf7', border: '1px solid #bbe8d0' }}>
                <div className="hc-mono" style={{ fontSize: 13, color: COLORS.mintDeep, fontWeight: 700, marginBottom: 6 }}>
                  PEER REVIEW · APPROVED +1
                </div>
                <div style={{ fontSize: 17.5, color: COLORS.ink, lineHeight: 1.45 }}>
                  <strong>{SCENARIO.peerName}</strong> ({SCENARIO.peerRole}): “Monotonic rank guard is clean. Probe Postgres row locks next round.”
                </div>
              </div>
              <div style={{ padding: '18px 20px', borderRadius: 12, background: COLORS.paper, border: `1px solid ${COLORS.border}` }}>
                <div className="hc-mono" style={{ fontSize: 13, color: COLORS.muted, fontWeight: 700, marginBottom: 6 }}>
                  CANDIDATE PORTAL ({SCENARIO.candidateCode})
                </div>
                <div style={{ fontSize: 17.5, color: COLORS.ink, lineHeight: 1.45 }}>
                  Transparent next step &amp; strengths published to candidate. Internal notes stay strictly private.
                </div>
              </div>
            </div>

            {/* Tailored Round-2 Questions */}
            <div
              style={{
                padding: '20px 24px',
                borderRadius: 14,
                background: '#faf7fc',
                border: '1px solid #dfd3ea',
              }}
            >
              <div className="hc-mono" style={{ fontSize: 13.5, color: COLORS.plum, fontWeight: 700, marginBottom: 10 }}>
                HANDOFF QUESTIONS FOR {SCENARIO.managerName.toUpperCase()} (VP OF ENGINEERING)
              </div>
              {KIMI_REVIEW.nextInterviewQuestions.map((q, i) => (
                <div key={q} style={{ fontSize: 19, color: COLORS.ink, lineHeight: 1.48, marginBottom: i === 0 ? 8 : 0 }}>
                  <strong style={{ color: COLORS.mintDeep }}>0{i + 1}.</strong> “{q}”
                </div>
              ))}
            </div>

            {/* Requirement Coverage Mini-Matrix */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
              {[
                { label: 'Delivery ID Dedupe', status: 'Demonstrated', pct: 96, pass: true },
                { label: 'Monotonic State Rank', status: 'Demonstrated', pct: 94, pass: true },
                { label: 'Concurrent Atomicity', status: 'Probe Round 2', pct: 48, pass: false },
              ].map((item) => (
                <div
                  key={item.label}
                  style={{
                    padding: '16px 18px',
                    borderRadius: 12,
                    background: COLORS.paper,
                    border: `1px solid ${COLORS.border}`,
                  }}
                >
                  <div style={{ fontSize: 16.5, fontWeight: 660, color: COLORS.ink, marginBottom: 4 }}>
                    {item.label}
                  </div>
                  <div
                    className="hc-mono"
                    style={{
                      fontSize: 13,
                      color: item.pass ? COLORS.mintDeep : COLORS.muted,
                      fontWeight: 650,
                      marginBottom: 10,
                    }}
                  >
                    {item.status}
                  </div>
                  <div style={{ height: 6, borderRadius: 999, background: '#e5ddd3', overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${item.pct}%`,
                        borderRadius: 999,
                        background: item.pass ? COLORS.mintDeep : COLORS.purple,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div
              style={{
                marginTop: 'auto',
                padding: '20px 26px',
                borderRadius: 12,
                background: COLORS.plum,
                color: COLORS.onPlum,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 20,
                fontWeight: 640,
              }}
            >
              <span>● Finalized by {SCENARIO.evaluatorName} ({SCENARIO.evaluatorRole})</span>
              <span className="hc-mono" style={{ fontSize: 15, color: COLORS.mint }}>NO AUTO-REJECT</span>
            </div>
          </div>
        </div>
      </TactileBackdrop>
    </AbsoluteFill>
  );
}

/**
 * STILL 05 — COMMON THREAD HORIZON MASTERBRAND POSTER (2400x1350, 16:9)
 */
export function Still05Horizon() {
  return (
    <AbsoluteFill className="hc-root">
      <TactileBackdrop kind="horizon" t={4} duration={10} dim={0.14}>
        <div style={{ position: 'absolute', left: 154, top: 122 }}>
          <BrandWordmark size={50} dark product={null} />
        </div>

        <div style={{ position: 'absolute', left: 154, top: 280, width: 1200 }}>
          <div className="hc-kicker" style={{ color: COLORS.mint, fontSize: 19, marginBottom: 24 }}>
            DIFFERENT WORK · ONE CLEAR PRINCIPLE
          </div>
          <div className="hc-headline" style={{ fontSize: 140, color: COLORS.onPlum }}>
            Evidence informs.
          </div>
          <div className="hc-headline" style={{ fontSize: 146, color: COLORS.mint, marginTop: 8 }}>
            People decide.
          </div>
        </div>

        {/* Stacked cleanly on the left so zero overlap with the physical silk threads */}
        <div
          style={{
            position: 'absolute',
            left: 154,
            bottom: 108,
            display: 'flex',
            gap: 16,
            alignItems: 'center',
          }}
        >
          {[
            { label: 'Software', tag: 'LIVE', color: COLORS.mint, primary: true },
            { label: 'IT', tag: 'HORIZON', color: COLORS.coral, primary: false },
            { label: 'Marketing', tag: 'HORIZON', color: COLORS.purple, primary: false },
          ].map((item) => (
            <div
              key={item.label}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 12,
                padding: '15px 22px',
                borderRadius: 12,
                background: item.primary ? 'rgba(33,20,38,0.92)' : 'rgba(33,20,38,0.72)',
                border: `1px solid ${item.primary ? 'rgba(176,240,206,0.48)' : 'rgba(245,239,230,0.2)'}`,
              }}
            >
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: item.color }} />
              <span style={{ fontSize: 23, fontWeight: item.primary ? 680 : 540, color: COLORS.onPlum }}>
                Hirearchy {item.label}
              </span>
              <span className="hc-mono" style={{ fontSize: 13.5, color: item.color, letterSpacing: '0.1em' }}>
                {item.tag}
              </span>
            </div>
          ))}
        </div>
      </TactileBackdrop>
    </AbsoluteFill>
  );
}
