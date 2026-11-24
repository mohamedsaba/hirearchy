import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
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
  EditorialHeader,
  Pill,
  StudioCursor,
  TactileBackdrop,
  ThreadFilament,
} from '../components/Primitives';

/**
 * ACT II — THE REAL TASK (11.5s – 21.5s, local t: 0.0 – 10.0s)
 * Living Hirearchy Assessment Builder:
 *   - Curated Templates · Kimi K3.1 Pro AI Generator · Reusable Problem Library
 *   - Role-tailored real bug (Payment Webhook Deduplication)
 *   - Explicit LIVE controls: Docker Sandbox Execution Active + Workspace AI Enabled & Logged
 *   - Clean Issue Assessment click
 */
export function Act2Builder() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const enter = prog(t, 0.0, 0.65, EASE_CAMERA);
  const windowIn = prog(t, 0.25, 1.1, EASE_EDITORIAL);
  const cameraGlide = prog(t, 1.0, 9.6, EASE_CAMERA);

  // Interactive states inside the live Builder
  const modeIndex = t < 1.65 ? 0 : t < 3.6 ? 1 : 0; // Templates -> Generate with Kimi K3.1 Pro -> Locked scenario
  const kimiHighlight = prog(t, 1.65, 2.15) * (1 - prog(t, 3.4, 3.85));
  const scenarioSelected = prog(t, 3.8, 4.35);
  const togglesOn = prog(t, 5.75, 6.45);
  const cursorAppear = prog(t, 6.75, 7.2);
  const cursorMove = prog(t, 7.1, 7.85, EASE_EDITORIAL);
  const issueClick = t >= 7.9 && t <= 8.2;
  const issuedState = prog(t, 8.05, 8.65);

  const tabs = [
    { id: 'templates', label: 'Platform Templates', badge: '3 curated' },
    { id: 'kimi', label: 'Generate with Advisory AI', badge: 'AI Builder' },
    { id: 'library', label: 'Saved Problem Library', badge: '14 team tasks' },
  ];

  return (
    <Curtain p={enter} from="right">
      <TactileBackdrop kind="paper" t={t} duration={10.5}>
        {/* Common Thread connecting from left margin into the Builder */}
        <ThreadFilament
          d="M -30 690 H 460 Q 545 690 615 628 L 760 540"
          amount={prog(t, 0.15, 1.9, EASE_CAMERA)}
          color={COLORS.mintDeep}
          strokeWidth={2.6}
          opacity={0.55}
          glow={false}
        />

        {/* LEFT EDITORIAL COLUMN */}
        <EditorialHeader
          kicker="01 / ASSESSMENT BUILDER"
          lines={['Start with', 'a real bug.']}
          t={t}
          start={0.22}
          size={84}
          style={{ position: 'absolute', left: 108, top: 236, width: 520 }}
        />

        <div
          className="hc-subcopy"
          style={{
            position: 'absolute',
            left: 112,
            top: 492,
            width: 450,
            fontSize: 24,
            color: COLORS.inkSoft,
            opacity: prog(t, 0.72, 1.4),
            transform: `translateY(${(1 - prog(t, 0.72, 1.4)) * 14}px)`,
          }}
        >
          Pick a production scenario, generate one with{' '}
          <strong style={{ color: COLORS.ink, fontWeight: 620 }}>Advisory AI</strong>, or reuse
          from your team library.
        </div>

        {/* Dynamic live status proof on left */}
        <div
          style={{
            position: 'absolute',
            left: 112,
            top: 642,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            opacity: togglesOn,
            transform: `translateY(${(1 - togglesOn) * 14}px)`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 17, color: COLORS.ink, fontWeight: 560 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: COLORS.pass }} />
            Isolated Docker execution active
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 17, color: COLORS.ink, fontWeight: 560 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: COLORS.mintDeep }} />
            Workspace AI allowed &amp; transparently logged
          </div>
        </div>

        {/* RIGHT: LIVING HIREARCHY BUILDER WINDOW (100% Vector Crisp) */}
        <div
          className="hc-window"
          style={{
            position: 'absolute',
            left: 654,
            top: 108,
            width: 1168,
            height: 864,
            background: COLORS.paperElevated,
            opacity: windowIn,
            transform: `translate3d(${lerp(56, 0, windowIn) - cameraGlide * 18}px, ${lerp(22, 0, windowIn)}px, 0) scale(${lerp(0.96, 1.015, cameraGlide)})`,
            transformOrigin: '60% 48%',
          }}
        >
          {/* Authentic Plum Product Masthead */}
          <div
            style={{
              height: 58,
              background: COLORS.plum,
              padding: '0 28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: `1px solid ${COLORS.plumLine}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
              <BrandWordmark size={22} dark />
              <div style={{ display: 'flex', gap: 22, fontSize: 13.5, color: COLORS.onPlumMuted }}>
                <span style={{ color: COLORS.onPlum, fontWeight: 600, borderBottom: `2px solid ${COLORS.mint}`, paddingBottom: 17, marginTop: 19 }}>
                  Builder
                </span>
                <span>Candidates</span>
                <span>Problem Library</span>
                <span>Handoffs</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span
                className="hc-mono"
                style={{
                  fontSize: 11.5,
                  padding: '4px 10px',
                  borderRadius: 999,
                  background: 'rgba(176,240,206,0.14)',
                  color: COLORS.mint,
                  border: '1px solid rgba(176,240,206,0.3)',
                }}
              >
                NORTHLINE ENG · ULTRA
              </span>
            </div>
          </div>

          {/* Builder Body */}
          <div
            style={{
              padding: '30px 36px',
              display: 'grid',
              gridTemplateColumns: '198px 1fr',
              gap: 32,
              background: COLORS.paper,
              height: 806,
            }}
          >
            {/* Stage Rail */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 6 }}>
              {[
                { n: '01', title: 'Problem', sub: 'Role & scenario', active: true },
                { n: '02', title: 'Preview', sub: 'Repo & rubric', active: scenarioSelected > 0.5 },
                { n: '03', title: 'Issue', sub: 'Assign & send', active: issuedState > 0.1 },
              ].map((step) => (
                <div
                  key={step.n}
                  style={{
                    padding: '13px 15px',
                    borderRadius: 12,
                    background: step.active ? COLORS.paperElevated : 'transparent',
                    border: step.active ? `1px solid ${COLORS.border}` : '1px solid transparent',
                  }}
                >
                  <div className="hc-mono" style={{ fontSize: 11, color: step.active ? COLORS.mintDeep : COLORS.muted, fontWeight: 600 }}>
                    STAGE {step.n}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 640, color: COLORS.ink, marginTop: 2 }}>
                    {step.title}
                  </div>
                  <div style={{ fontSize: 13, color: COLORS.muted }}>{step.sub}</div>
                </div>
              ))}
            </div>

            {/* Main Authoring Canvas */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <div>
                  <div style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.04em', color: COLORS.ink }}>
                    Assessment Builder
                  </div>
                  <div style={{ fontSize: 14.5, color: COLORS.muted, marginTop: 3 }}>
                    Configure a bounded real-repository task with transparent tooling policy.
                  </div>
                </div>
              </div>

              {/* 3 Source Mode Tabs */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 10,
                  background: COLORS.paperSubtle,
                  padding: 6,
                  borderRadius: 12,
                  border: `1px solid ${COLORS.border}`,
                }}
              >
                {tabs.map((tab, i) => {
                  const isActive = i === modeIndex;
                  return (
                    <div
                      key={tab.id}
                      style={{
                        padding: '10px 14px',
                        borderRadius: 9,
                        background: isActive ? COLORS.plum : 'transparent',
                        color: isActive ? COLORS.onPlum : COLORS.inkSoft,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: 13.5,
                        fontWeight: isActive ? 620 : 520,
                      }}
                    >
                      <span>{tab.label}</span>
                      <span
                        className="hc-mono"
                        style={{
                          fontSize: 10.5,
                          padding: '2px 7px',
                          borderRadius: 999,
                          background: isActive ? 'rgba(176,240,206,0.18)' : 'rgba(36,24,43,0.06)',
                          color: isActive ? COLORS.mint : COLORS.muted,
                        }}
                      >
                        {tab.badge}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Kimi AI Generation Banner (briefly highlights at 1.65s–3.6s!) */}
              {kimiHighlight > 0.02 ? (
                <div
                  style={{
                    padding: '18px 22px',
                    borderRadius: 14,
                    background: COLORS.plum,
                    color: COLORS.onPlum,
                    border: `1px solid rgba(176, 240, 206, 0.32)`,
                    opacity: kimiHighlight,
                    transform: `translateY(${(1 - kimiHighlight) * 8}px)`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div className="hc-mono" style={{ fontSize: 11, color: COLORS.mint, letterSpacing: '0.12em' }}>
                      ADVISORY AI · ROLE-TAILORED REPO GENERATOR
                    </div>
                    <div style={{ fontSize: 17, fontWeight: 560, marginTop: 4 }}>
                      Senior Backend · Python · Concurrency &amp; Idempotency → 4 starter files + pytest suite
                    </div>
                  </div>
                  <Pill tone="darkMint">Multi-file repo</Pill>
                </div>
              ) : null}

              {/* Selected Scenario Card */}
              <div
                className="hc-card"
                style={{
                  padding: '22px 24px',
                  borderColor: scenarioSelected > 0.3 ? COLORS.mintDeep : COLORS.border,
                  boxShadow:
                    scenarioSelected > 0.3
                      ? '0 14px 36px rgba(47, 111, 84, 0.12), 0 0 0 1px rgba(47, 111, 84, 0.28)'
                      : undefined,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                      <Pill tone="plum">{SCENARIO.role}</Pill>
                      <Pill tone="neutral">{SCENARIO.level}</Pill>
                      <Pill tone="mint">{SCENARIO.duration}</Pill>
                    </div>
                    <div style={{ fontSize: 23, fontWeight: 660, letterSpacing: '-0.03em', color: COLORS.ink }}>
                      {SCENARIO.title}
                    </div>
                  </div>
                  <div className="hc-mono" style={{ fontSize: 12, color: COLORS.muted, textAlign: 'right' }}>
                    4 files · pytest
                    <br />
                    src/webhook_handler.py
                  </div>
                </div>
                <div style={{ fontSize: 14.5, color: COLORS.inkSoft, lineHeight: 1.5 }}>
                  Duplicate upstream webhook deliveries double-credit merchant balances, and delayed{' '}
                  <span className="hc-mono" style={{ fontSize: 13, background: COLORS.paperSubtle, padding: '1px 5px', borderRadius: 4 }}>
                    payment.authorized
                  </span>{' '}
                  events regress settled payments. Fix deduplication and monotonic state ordering.
                </div>
              </div>

              {/* LIVE Workspace Controls Grid — ZERO "Unavailable"! */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 14,
                }}
              >
                {[
                  {
                    title: 'Docker Sandbox Execution',
                    desc: 'Isolated Python container runs pytest on demand.',
                    active: togglesOn > 0.25,
                    badge: 'ACTIVE',
                  },
                  {
                    title: 'Candidate Workspace AI',
                    desc: 'Workspace AI available inside IDE · neutrally logged.',
                    active: togglesOn > 0.55,
                    badge: 'LOGGED · NEUTRAL',
                  },
                ].map((ctrl) => (
                  <div
                    key={ctrl.title}
                    className="hc-card"
                    style={{
                      padding: '16px 18px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      borderColor: ctrl.active ? '#9fe5c2' : COLORS.border,
                      background: ctrl.active ? '#f7fdf9' : COLORS.paperElevated,
                    }}
                  >
                    <div style={{ paddingRight: 12 }}>
                      <div style={{ fontSize: 15, fontWeight: 640, color: COLORS.ink }}>
                        {ctrl.title}
                      </div>
                      <div style={{ fontSize: 12.5, color: COLORS.muted, marginTop: 3 }}>
                        {ctrl.desc}
                      </div>
                    </div>
                    {/* Crisp Toggle Switch */}
                    <div
                      style={{
                        width: 48,
                        height: 28,
                        borderRadius: 999,
                        background: ctrl.active ? COLORS.mintDeep : '#d6cdc4',
                        padding: 3,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: ctrl.active ? 'flex-end' : 'flex-start',
                        flexShrink: 0,
                      }}
                    >
                      <div
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          background: '#ffffff',
                          boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* Invitation Bar & Issue Button */}
              <div
                className="hc-card"
                style={{
                  padding: '16px 22px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 'auto',
                }}
              >
                <div style={{ display: 'flex', gap: 28 }}>
                  <div>
                    <div className="hc-mono" style={{ fontSize: 10.5, color: COLORS.muted, letterSpacing: '0.1em' }}>
                      CANDIDATE
                    </div>
                    <div style={{ fontSize: 14.5, fontWeight: 600, color: COLORS.ink, marginTop: 2 }}>
                      {SCENARIO.candidateEmail}
                    </div>
                  </div>
                  <div>
                    <div className="hc-mono" style={{ fontSize: 10.5, color: COLORS.muted, letterSpacing: '0.1em' }}>
                      ASSIGNED EVALUATOR
                    </div>
                    <div style={{ fontSize: 14.5, fontWeight: 600, color: COLORS.ink, marginTop: 2 }}>
                      {SCENARIO.evaluatorName} · {SCENARIO.evaluatorRole}
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    padding: '13px 24px',
                    borderRadius: 10,
                    background: issuedState > 0.1 ? COLORS.mintDeep : COLORS.plum,
                    color: COLORS.onPlum,
                    fontSize: 15,
                    fontWeight: 640,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 10,
                    transform: `scale(${issueClick ? 0.96 : 1})`,
                  }}
                >
                  {issuedState > 0.1 ? '✓ Assessment Issued' : 'Issue Assessment →'}
                </div>
              </div>
            </div>
          </div>

          {/* Crisp Studio Pointer gliding to Issue Assessment */}
          <StudioCursor
            x={lerp(720, 1020, cursorMove)}
            y={lerp(640, 795, cursorMove)}
            opacity={cursorAppear * (1 - prog(t, 8.8, 9.3))}
            clicking={issueClick}
          />
        </div>
      </TactileBackdrop>
    </Curtain>
  );
}
