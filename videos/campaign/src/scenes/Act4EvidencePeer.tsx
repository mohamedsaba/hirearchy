import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  CHRONOLOGY_EVENTS,
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
  EditorialHeader,
  Pill,
  PythonLine,
  TactileBackdrop,
  ThreadFilament,
} from '../components/Primitives';

/**
 * ACT IV — CHRONOLOGY, DIFF & TEAM PEER REVIEW (39.0s – 55.0s, local t: 0.0 – 16.0s)
 *   Part A (0.0 – 8.5s): Warm daylight paper — Chronological Reconstruction with REAL Δ timing deltas
 *                         + Line-Numbered Unified Diff + Source-Anchored Evaluator Observation
 *   Part B (8.5 – 16.0s): Archival lilac rag — GitHub-PR-Style Team Peer Review
 *                         (Sam Rivera -> mint thread -> Jordan Lee -> "Approved · +1")
 */
export function Act4EvidencePeer() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const enter = prog(t, 0.0, 0.65, EASE_CAMERA);
  const diffIn = prog(t, 2.2, 3.0, EASE_EDITORIAL);
  const noteIn = prog(t, 5.5, 6.35, EASE_EDITORIAL);

  // Part B (Peer Review on Archival Lilac) starts at local t = 8.5s
  const peerEnter = prog(t, 8.45, 9.15, EASE_CAMERA);
  const pt = t - 8.5;
  const reqCard = prog(pt, 0.35, 1.05);
  const peerThread = prog(pt, 1.15, 2.85, EASE_CAMERA);
  const replyCard = prog(pt, 2.65, 3.45, EASE_EDITORIAL);
  const approvedBadge = prog(pt, 3.55, 4.1);
  const peerPayoff = prog(pt, 4.65, 5.5);

  const diffRows = [
    { o: '112', n: '112', type: 'ctx', code: 'def handle_webhook(ledger: MerchantLedger, event: WebhookEvent) -> str:' },
    { o: '   ', n: '113', type: 'add', code: '    delivery_id = event["delivery_id"]' },
    { o: '   ', n: '114', type: 'add', code: '    if delivery_id in ledger.processed_deliveries:' },
    { o: '   ', n: '115', type: 'add', code: '        existing = ledger.payments.get(event["payment_id"])' },
    { o: '   ', n: '116', type: 'add', code: '        return existing.status if existing else "pending"' },
    { o: '117', n: '121', type: 'ctx', code: '    target = EVENT_TO_STATUS.get(event["event_type"])' },
    { o: '118', n: '   ', type: 'del', code: '    # BUG: does not deduplicate delivery_id or guard transitions' },
    { o: '   ', n: '122', type: 'add', code: '    ledger.processed_deliveries.add(delivery_id)' },
    { o: '   ', n: '123', type: 'add', code: '    if STATUS_RANK[target] <= STATUS_RANK[payment.status]:' },
    { o: '   ', n: '124', type: 'add', code: '        return payment.status' },
  ];

  return (
    <Curtain p={enter} from="left">
      <AbsoluteFill>
        {/* PART A: OBSERVABLE CHRONOLOGY & UNIFIED DIFF (Warm Cotton Daylight) */}
        <TactileBackdrop kind="paper" t={t} duration={9.0}>
          <EditorialHeader
            kicker="03 / OBSERVABLE CHRONOLOGY & DIFF"
            lines={['See how the mind moved.']}
            t={t}
            start={0.18}
            size={74}
            style={{ position: 'absolute', left: 108, top: 68 }}
          />

          <div
            className="hc-subcopy"
            style={{
              position: 'absolute',
              left: 112,
              top: 196,
              fontSize: 22,
              color: COLORS.inkSoft,
              opacity: prog(t, 0.55, 1.15),
            }}
          >
            Every test run, neutral AI query, save checkpoint, and <strong style={{ color: COLORS.ink }}>timing delta</strong> — anchored to source diffs.
          </div>

          {/* TWO-COLUMN EVIDENCE WORKBENCH */}
          <div
            style={{
              position: 'absolute',
              left: 108,
              right: 108,
              top: 262,
              bottom: 72,
              display: 'grid',
              gridTemplateColumns: '550px 1fr',
              gap: 34,
            }}
          >
            {/* LEFT: CHRONOLOGY SPINE WITH REAL Δ TIMING DELTAS */}
            <div
              className="hc-card"
              style={{
                padding: '26px 28px',
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingBottom: 16,
                  marginBottom: 18,
                  borderBottom: `1px solid ${COLORS.border}`,
                }}
              >
                <div style={{ fontSize: 20, fontWeight: 660, color: COLORS.ink }}>
                  Session Chronology
                </div>
                <span className="hc-mono" style={{ fontSize: 12.5, color: COLORS.muted }}>
                  14m 22s · 6 events
                </span>
              </div>

              <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                {/* Vertical Spine Rail */}
                <div
                  style={{
                    position: 'absolute',
                    left: 13,
                    top: 16,
                    width: 2,
                    height: `${prog(t, 0.6, 4.2, EASE_CAMERA) * 90}%`,
                    background: COLORS.mintDeep,
                    opacity: 0.45,
                  }}
                />

                {CHRONOLOGY_EVENTS.map((ev, i) => {
                  const pEv = prog(t, 0.65 + i * 0.52, 1.2 + i * 0.52);
                  const isSelected = ev.seq === 4 && t >= 2.2;
                  const dotCol =
                    ev.kind === 'fail'
                      ? COLORS.fail
                      : ev.kind === 'ai'
                        ? '#7e22ce'
                        : ev.kind === 'pass' || ev.kind === 'save' || ev.kind === 'submit'
                          ? COLORS.mintDeep
                          : COLORS.muted;
                  return (
                    <div
                      key={ev.seq}
                      style={{
                        display: 'flex',
                        gap: 16,
                        alignItems: 'flex-start',
                        padding: '10px 14px 10px 6px',
                        borderRadius: 11,
                        background: isSelected ? '#edfbf3' : 'transparent',
                        border: isSelected ? '1px solid #9fe5c2' : '1px solid transparent',
                        opacity: pEv,
                        transform: `translate3d(${(1 - pEv) * 18}px, 0, 0)`,
                      }}
                    >
                      <div
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          marginTop: 5,
                          background: isSelected ? COLORS.mintDeep : COLORS.paperElevated,
                          border: `2.5px solid ${dotCol}`,
                          flexShrink: 0,
                          zIndex: 2,
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                          <span style={{ fontSize: 15, fontWeight: 650, color: COLORS.ink }}>
                            {ev.title}
                          </span>
                          <span
                            className="hc-mono"
                            style={{
                              fontSize: 11.5,
                              color: ev.seq > 1 ? COLORS.mintDeep : COLORS.muted,
                              background: ev.seq > 1 ? '#eef8f2' : COLORS.paperSubtle,
                              padding: '2px 7px',
                              borderRadius: 6,
                              flexShrink: 0,
                              fontWeight: 600,
                            }}
                          >
                            +{ev.offset} · {ev.delta}
                          </span>
                        </div>
                        <div style={{ fontSize: 13, color: COLORS.muted, marginTop: 3 }}>
                          {ev.detail}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* RIGHT: UNIFIED DIFF + SOURCE-ANCHORED EVALUATOR OBSERVATION */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
                opacity: diffIn,
                transform: `translate3d(${(1 - diffIn) * 32}px, 0, 0)`,
              }}
            >
              <div className="hc-card" style={{ overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column' }}>
                {/* Diff Header */}
                <div
                  style={{
                    padding: '16px 24px',
                    background: COLORS.paperSubtle,
                    borderBottom: `1px solid ${COLORS.border}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div className="hc-mono" style={{ fontSize: 11, color: COLORS.muted, letterSpacing: '0.1em' }}>
                      SUBMITTED DIFF · REVISION v2
                    </div>
                    <div className="hc-mono" style={{ fontSize: 16, fontWeight: 650, color: COLORS.ink, marginTop: 2 }}>
                      {SCENARIO.primaryFile}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Pill tone="pass">+14</Pill>
                    <Pill tone="fail">-4</Pill>
                    <Pill tone="mint">4 / 4 tests verified</Pill>
                  </div>
                </div>

                {/* Diff Lines */}
                <div
                  className="hc-mono"
                  style={{
                    padding: '14px 0',
                    fontSize: 14.2,
                    lineHeight: 1.78,
                    background: COLORS.paperElevated,
                    flex: 1,
                  }}
                >
                  {diffRows.map((row, idx) => {
                    const isAnchored = idx >= 7 && noteIn > 0.25;
                    return (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          padding: '0 22px',
                          background:
                            row.type === 'add'
                              ? isAnchored
                                ? '#d5f6e5'
                                : '#ecfdf3'
                              : row.type === 'del'
                                ? '#fef2f2'
                                : 'transparent',
                          borderLeft: isAnchored
                            ? `4px solid ${COLORS.mintDeep}`
                            : '4px solid transparent',
                        }}
                      >
                        <span style={{ width: 42, color: '#9c8fa3', fontSize: 12.5 }}>{row.o}</span>
                        <span style={{ width: 42, color: '#9c8fa3', fontSize: 12.5 }}>{row.n}</span>
                        <span
                          style={{
                            width: 20,
                            fontWeight: 700,
                            color: row.type === 'add' ? COLORS.pass : row.type === 'del' ? COLORS.fail : '#9c8fa3',
                          }}
                        >
                          {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}
                        </span>
                        <span style={{ whiteSpace: 'pre' }}>
                          <PythonLine text={row.code} theme="light" />
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Anchored Evaluator Observation Card */}
              <div
                className="hc-card"
                style={{
                  padding: '20px 24px',
                  borderColor: COLORS.mintDeep,
                  background: '#fafdfb',
                  boxShadow: '0 20px 54px rgba(47, 111, 84, 0.14)',
                  opacity: noteIn,
                  transform: `translateY(${(1 - noteIn) * 24}px)`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Pill tone="plum">Anchored Observation</Pill>
                    <span className="hc-mono" style={{ fontSize: 12.5, color: COLORS.mintDeep, fontWeight: 600 }}>
                      src/webhook_handler.py · Lines 122–124 · sha256:8f41c2…
                    </span>
                  </div>
                  <span style={{ fontSize: 13, color: COLORS.muted }}>{SCENARIO.evaluatorName}</span>
                </div>
                <div style={{ fontSize: 18, color: COLORS.ink, fontWeight: 540, lineHeight: 1.45 }}>
                  “Clean monotonic rank check. Let&apos;s probe in round 2 how they&apos;d enforce this atomically under concurrent Postgres workers.”
                </div>
              </div>
            </div>
          </div>

          {/* Subtle thread linking Timeline v2 to Diff */}
          <ThreadFilament
            d="M 656 598 H 695"
            amount={diffIn}
            color={COLORS.mintDeep}
            strokeWidth={2.6}
            opacity={0.75}
            glow={false}
          />
        </TactileBackdrop>

        {/* PART B: GITHUB-PR-STYLE TEAM PEER REVIEW (Archival Lilac Rag, t >= 8.4s) */}
        {t >= 8.4 ? (
          <Curtain p={peerEnter} from="right">
            <TactileBackdrop kind="lilac" t={pt} duration={8.0}>
              {/* Header Bar */}
              <div
                style={{
                  position: 'absolute',
                  left: 108,
                  right: 108,
                  top: 66,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                }}
              >
                <EditorialHeader
                  kicker="04 / TEAM PEER REVIEW"
                  lines={['One record.', 'Every perspective.']}
                  t={pt}
                  start={0.12}
                  size={82}
                />
                <div style={{ paddingTop: 12, opacity: prog(pt, 0.4, 1.0) }}>
                  <BrandWordmark size={24} dark={false} />
                </div>
              </div>

              <div
                className="hc-subcopy"
                style={{
                  position: 'absolute',
                  left: 112,
                  top: 316,
                  fontSize: 23,
                  color: COLORS.inkSoft,
                  opacity: prog(pt, 0.5, 1.05),
                }}
              >
                Request a GitHub-PR-style second opinion from a Staff Engineer, CTO, or Recruiter — anchored to the exact same evidence.
              </div>

              {/* Luminous Thread bridging Sam Rivera -> Jordan Lee */}
              <ThreadFilament
                d="M 150 448 H 910 Q 960 448 1005 448 H 1760"
                amount={peerThread}
                color={COLORS.mintDeep}
                strokeWidth={3}
                opacity={0.72}
                glow={false}
              />

              {/* Teammate Labels along the thread */}
              <div
                style={{
                  position: 'absolute',
                  left: 112,
                  top: 400,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  opacity: reqCard,
                }}
              >
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: COLORS.plum }} />
                <span style={{ fontSize: 20, fontWeight: 680, color: COLORS.ink }}>{SCENARIO.evaluatorName}</span>
                <span style={{ fontSize: 16, color: COLORS.muted }}>{SCENARIO.evaluatorRole}</span>
              </div>

              <div
                style={{
                  position: 'absolute',
                  left: 1012,
                  top: 400,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  opacity: prog(pt, 1.8, 2.4),
                }}
              >
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: COLORS.mintDeep }} />
                <span style={{ fontSize: 20, fontWeight: 680, color: COLORS.ink }}>{SCENARIO.peerName}</span>
                <span style={{ fontSize: 16, color: COLORS.muted }}>{SCENARIO.peerRole}</span>
              </div>

              {/* TWO SIDE-BY-SIDE PEER REVIEW CARDS */}
              <div
                style={{
                  position: 'absolute',
                  left: 112,
                  right: 112,
                  top: 486,
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 44,
                  alignItems: 'start',
                }}
              >
                {/* Left Card: Second Opinion Request */}
                <div
                  className="hc-card"
                  style={{
                    padding: '32px 34px',
                    opacity: reqCard,
                    transform: `translateY(${(1 - reqCard) * 28}px)`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                    <span className="hc-mono" style={{ fontSize: 12, color: COLORS.muted, letterSpacing: '0.1em' }}>
                      SECOND OPINION REQUESTED
                    </span>
                    <Pill tone="lilac">PR-style thread</Pill>
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 640, color: COLORS.ink, marginBottom: 14 }}>
                    Focus question for Jordan Lee
                  </div>
                  <div
                    style={{
                      padding: '18px 20px',
                      borderRadius: 12,
                      background: COLORS.paper,
                      border: `1px solid ${COLORS.border}`,
                      fontSize: 18,
                      color: COLORS.ink,
                      lineHeight: 1.5,
                      marginBottom: 20,
                    }}
                  >
                    “Can you verify the out-of-order <span className="hc-mono" style={{ fontSize: 15 }}>STATUS_RANK</span> guard in <span className="hc-mono" style={{ fontSize: 15 }}>webhook_handler.py</span> and check if we should probe concurrency locking?”
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <Pill tone="neutral">Linked: Revision v2 (+14/-4)</Pill>
                    <Pill tone="neutral">Linked: 1 Observation</Pill>
                    <Pill tone="mint">Email + direct link sent</Pill>
                  </div>
                </div>

                {/* Right Card: Peer Response + Approved Verdict */}
                <div
                  className="hc-card"
                  style={{
                    padding: '32px 34px',
                    borderColor: approvedBadge > 0.3 ? COLORS.mintDeep : COLORS.border,
                    boxShadow:
                      approvedBadge > 0.3
                        ? '0 24px 64px rgba(47, 111, 84, 0.16), 0 0 0 1px rgba(47, 111, 84, 0.3)'
                        : undefined,
                    opacity: replyCard,
                    transform: `translateY(${(1 - replyCard) * 28}px)`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                    <span className="hc-mono" style={{ fontSize: 12, color: COLORS.mintDeep, letterSpacing: '0.1em', fontWeight: 650 }}>
                      PEER RESPONSE · INTERNAL ONLY
                    </span>
                    <div
                      style={{
                        transform: `scale(${lerp(0.82, 1, approvedBadge)})`,
                        opacity: approvedBadge,
                      }}
                    >
                      <Pill tone="pass" style={{ fontSize: 14, padding: '7px 14px', fontWeight: 700 }}>
                        ✓ Approved · +1 Advance
                      </Pill>
                    </div>
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 640, color: COLORS.ink, marginBottom: 14 }}>
                    Jordan Lee reviewed the diff &amp; chronology
                  </div>
                  <div
                    style={{
                      padding: '18px 20px',
                      borderRadius: 12,
                      background: '#f4fbf7',
                      border: '1px solid #b7ead0',
                      fontSize: 18,
                      color: COLORS.ink,
                      lineHeight: 1.5,
                      marginBottom: 20,
                    }}
                  >
                    “Idempotency key check and monotonic rank guard are clean and idiomatic. Asking about Postgres row-level locking in the next round is the exact right probe.”
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      opacity: peerPayoff,
                    }}
                  >
                    <span style={{ fontSize: 15, color: COLORS.muted }}>
                      Stays private to the hiring team
                    </span>
                    <span style={{ fontSize: 18, fontWeight: 680, color: COLORS.plum }}>
                      Aligned before the debrief.
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
