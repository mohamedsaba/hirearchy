import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  CODE_ADDED_DEDUPE,
  CODE_ADDED_GUARD,
  CODE_FOOTER_LINES,
  CODE_HEADER_LINES,
  CODE_MIDDLE_LINES,
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
  PythonLine,
  StudioCursor,
  TactileBackdrop,
  ThreadFilament,
} from '../components/Primitives';

/**
 * ACT III — THE AUTHENTIC IDE (21.5s – 39.0s, local t: 0.0 – 17.5s)
 * Zero Surveillance. Real Engineering:
 *   0.0–3.5s: Authentic plum dark IDE opens; Docker Sandbox Terminal runs pytest -> 2 FAILED
 *   3.5–8.0s: Workspace AI drawer glides in (TRANSPARENTLY LOGGED · NEUTRAL)
 *   8.0–13.5s: 1.72x vector-crisp macro camera push-in onto src/webhook_handler.py;
 *              real Python idempotency & STATUS_RANK fix types in live -> Saved v2 (11:05)
 *   13.5–17.5s: Pull back, Docker pytest re-runs -> 4 PASSED in 0.14s -> Submit assessment!
 */
export function Act3Ide() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const enter = prog(t, 0.0, 0.7, EASE_CAMERA);
  const titleFade = prog(t, 0.25, 0.85) * (1 - prog(t, 7.2, 7.9));

  // Terminal first run (fail at t=3.1s) and second run (pass at t=14.9s)
  const firstFail = prog(t, 2.7, 3.25);
  const aiOpen = prog(t, 4.05, 4.75, EASE_EDITORIAL) * (1 - prog(t, 8.0, 8.65));
  const aiReply = prog(t, 5.2, 6.9, EASE_CAMERA);

  // Macro push-in on code lines (8.2s -> 13.6s)
  const pushIn = prog(t, 8.15, 9.25, EASE_CAMERA);
  const pullOut = prog(t, 12.85, 13.95, EASE_CAMERA);
  const macro = pushIn * (1 - pullOut);

  // Live typing progress across dedupe + guard lines (8.7s -> 12.1s)
  const dedupeText = CODE_ADDED_DEDUPE.join('\n');
  const guardText = CODE_ADDED_GUARD.join('\n');
  const totalChars = dedupeText.length + guardText.length;
  const typedCount = Math.floor(prog(t, 8.75, 12.05, EASE_CAMERA) * totalChars);

  const typedDedupe = dedupeText.slice(
    0,
    Math.min(typedCount, dedupeText.length),
  );
  const typedGuard =
    typedCount > dedupeText.length
      ? guardText.slice(0, typedCount - dedupeText.length)
      : '';

  const showTypedBlock = typedCount > 0;
  const dedupeLines = showTypedBlock ? typedDedupe.split('\n') : [];
  const guardLines = typedGuard.length > 0 ? typedGuard.split('\n') : [];

  const savedV2 = prog(t, 12.25, 12.7);
  const secondPass = prog(t, 14.75, 15.25);
  const cursorToSubmit = prog(t, 15.5, 16.3, EASE_EDITORIAL);
  const submitClick = t >= 16.35 && t <= 16.6;
  const submitted = prog(t, 16.4, 16.85);
  const exitThread = prog(t, 16.55, 17.5, EASE_CAMERA);

  // Build visible code lines dynamically
  const editorLines: Array<{
    num: number;
    text: string;
    added?: boolean;
    removed?: boolean;
  }> = [];
  let ln = 108;
  for (const h of CODE_HEADER_LINES) {
    editorLines.push({ num: ln++, text: h.text });
  }
  for (const dl of dedupeLines) {
    editorLines.push({ num: ln++, text: dl, added: true });
  }
  for (const ml of CODE_MIDDLE_LINES) {
    editorLines.push({ num: ln++, text: ml });
  }
  if (!showTypedBlock) {
    editorLines.push({
      num: ln++,
      text: '    # BUG: does not deduplicate delivery_id or guard out-of-order transitions',
      removed: true,
    });
  } else {
    for (const gl of guardLines) {
      editorLines.push({ num: ln++, text: gl, added: true });
    }
  }
  for (const fl of CODE_FOOTER_LINES) {
    editorLines.push({ num: ln++, text: fl });
  }

  // Remaining timer ticking realistically
  const timerStr = t < 8.5 ? '56:48' : t < 13.5 ? '48:55' : '45:38';
  const caretOn = Math.floor(frame / 18) % 2 === 0;

  return (
    <Curtain p={enter} from="bottom">
      <TactileBackdrop kind="plum" t={t} duration={18}>
        {/* Top Editorial Context Strip (fades out cleanly during macro push-in) */}
        <div
          style={{
            position: 'absolute',
            left: 96,
            right: 96,
            top: 46,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            opacity: titleFade,
          }}
        >
          <div>
            <div
              className="hc-kicker"
              style={{ color: COLORS.mint, fontSize: 14, marginBottom: 8 }}
            >
              02 / CANDIDATE WORKSPACE · ZERO SPYWARE
            </div>
            <div
              className="hc-headline"
              style={{ fontSize: 48, color: COLORS.onPlum }}
            >
              A real repository. Authentic tools.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Pill tone="darkMint">Docker Sandbox Live</Pill>
            <Pill
              tone="darkMint"
              style={{
                background: 'rgba(187, 152, 244, 0.14)',
                color: COLORS.purple,
                borderColor: 'rgba(187, 152, 244, 0.34)',
              }}
            >
              AI Neutrally Logged
            </Pill>
          </div>
        </div>

        {/* FULL LIVING IDE STAGE WITH SMOOTH VECTOR MACRO CAMERA RIG */}
        <div
          className="hc-window-dark"
          style={{
            position: 'absolute',
            left: 96,
            top: 150,
            width: 1728,
            height: 856,
            background: '#170e20',
            transform: `translate3d(${-macro * 210}px, ${-macro * 135}px, 0) scale(${1 + macro * 0.62})`,
            transformOrigin: '36% 36%',
          }}
        >
          {/* IDE Header (Matches Hirearchy live R26 header pixel-for-pixel) */}
          <div
            style={{
              height: 58,
              background: COLORS.plum,
              borderBottom: `1px solid ${COLORS.plumLine}`,
              padding: '0 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <BrandWordmark size={22} dark />
              <div
                style={{
                  borderLeft: `1px solid ${COLORS.plumLine}`,
                  paddingLeft: 16,
                  fontSize: 14,
                  fontWeight: 560,
                  color: COLORS.onPlumMuted,
                }}
              >
                {SCENARIO.title}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span
                className="hc-mono"
                style={{
                  fontSize: 12.5,
                  padding: '6px 12px',
                  borderRadius: 8,
                  border: `1px solid ${COLORS.plumLine}`,
                  color: COLORS.onPlum,
                  background: '#1b1024',
                }}
              >
                Time left <strong>{timerStr}</strong>
              </span>
              <span
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  background: submitted > 0.2 ? '#166534' : COLORS.mintStrong,
                  color: submitted > 0.2 ? '#ecfdf3' : COLORS.plum,
                  fontSize: 13.5,
                  fontWeight: 700,
                  transform: `scale(${submitClick ? 0.94 : 1})`,
                }}
              >
                {submitted > 0.2 ? '✓ Submitted' : 'Submit assessment'}
              </span>
            </div>
          </div>

          {/* IDE Main Body Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '256px 1fr',
              height: 762,
              position: 'relative',
            }}
          >
            {/* Left File Explorer */}
            <div
              style={{
                background: '#1b1124',
                borderRight: `1px solid ${COLORS.plumLine}`,
                padding: '18px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div
                className="hc-mono"
                style={{
                  fontSize: 11,
                  letterSpacing: '0.14em',
                  color: COLORS.onPlumFaint,
                  padding: '0 8px 8px',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>FILES</span>
                <span>4 files</span>
              </div>
              {[
                { name: 'src/', folder: true },
                { name: '  models.py', active: false },
                { name: '  ledger.py', active: false },
                { name: '  webhook_handler.py', active: true },
                { name: 'tests/', folder: true },
                { name: '  test_webhooks.py', active: false },
              ].map((item) => (
                <div
                  key={item.name}
                  className="hc-mono"
                  style={{
                    fontSize: 13,
                    padding: '7px 10px',
                    borderRadius: 8,
                    whiteSpace: 'pre',
                    background: item.active
                      ? 'rgba(176, 240, 206, 0.14)'
                      : 'transparent',
                    color: item.active
                      ? COLORS.mint
                      : item.folder
                        ? COLORS.onPlumMuted
                        : '#d7cbe0',
                    fontWeight: item.active ? 620 : 450,
                  }}
                >
                  {item.folder ? `▾ ${item.name}` : item.name}
                </div>
              ))}

              <div
                style={{
                  marginTop: 22,
                  paddingTop: 16,
                  borderTop: `1px solid ${COLORS.plumLine}`,
                }}
              >
                <div
                  className="hc-mono"
                  style={{
                    fontSize: 11,
                    color: COLORS.onPlumFaint,
                    letterSpacing: '0.12em',
                    marginBottom: 10,
                  }}
                >
                  ACCEPTANCE CRITERIA
                </div>
                {[
                  { txt: 'Deduplicate delivery_id', done: secondPass > 0.4 },
                  { txt: 'Enforce monotonic status', done: secondPass > 0.4 },
                  { txt: 'Preserve ledger invariants', done: secondPass > 0.4 },
                ].map((c) => (
                  <div
                    key={c.txt}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12.5,
                      color: c.done ? COLORS.mint : COLORS.onPlumMuted,
                      marginBottom: 8,
                    }}
                  >
                    <span>{c.done ? '✓' : '○'}</span>
                    <span>{c.txt}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Center Editor + Bottom Docker Sandbox Terminal */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
              }}
            >
              {/* Editor Tab Bar */}
              <div
                style={{
                  height: 44,
                  background: '#1d1227',
                  borderBottom: `1px solid ${COLORS.plumLine}`,
                  padding: '0 18px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', gap: 4, height: '100%' }}>
                  {[
                    'models.py',
                    'ledger.py',
                    'webhook_handler.py',
                    'test_webhooks.py',
                  ].map((tab) => {
                    const active = tab === 'webhook_handler.py';
                    return (
                      <div
                        key={tab}
                        className="hc-mono"
                        style={{
                          fontSize: 12.5,
                          padding: '0 14px',
                          display: 'flex',
                          alignItems: 'center',
                          color: active ? COLORS.onPlum : COLORS.onPlumFaint,
                          borderBottom: active
                            ? `2px solid ${COLORS.mint}`
                            : '2px solid transparent',
                          background: active ? '#170e20' : 'transparent',
                        }}
                      >
                        {tab}
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span
                    className="hc-mono"
                    style={{
                      fontSize: 12,
                      color: savedV2 > 0.2 ? COLORS.mint : COLORS.onPlumFaint,
                    }}
                  >
                    {savedV2 > 0.2
                      ? '● Saved v2 · 11:05'
                      : '● Clean checkpoint v1'}
                  </span>
                </div>
              </div>

              {/* Code Canvas */}
              <div
                className="hc-mono"
                style={{
                  flex: 1,
                  padding: '16px 0',
                  fontSize: 15,
                  lineHeight: 1.62,
                  overflow: 'hidden',
                  background: '#150c1d',
                }}
              >
                {editorLines.slice(0, 22).map((line, i) => {
                  const isLastAdded =
                    showTypedBlock &&
                    typedCount < totalChars &&
                    line.added &&
                    (i === editorLines.length - 1 ||
                      !editorLines[i + 1]?.added);
                  return (
                    <div
                      key={`${line.num}-${i}`}
                      style={{
                        display: 'flex',
                        padding: '0 22px',
                        background: line.added
                          ? 'rgba(176, 240, 206, 0.085)'
                          : line.removed
                            ? 'rgba(255, 138, 128, 0.07)'
                            : 'transparent',
                        borderLeft: line.added
                          ? `3px solid ${COLORS.mint}`
                          : '3px solid transparent',
                      }}
                    >
                      <span
                        style={{
                          width: 44,
                          color: COLORS.onPlumFaint,
                          userSelect: 'none',
                          flexShrink: 0,
                          textAlign: 'right',
                          paddingRight: 18,
                          fontSize: 13,
                        }}
                      >
                        {line.num}
                      </span>
                      <span style={{ whiteSpace: 'pre' }}>
                        <PythonLine text={line.text} theme="dark" />
                        {isLastAdded && caretOn ? (
                          <span
                            style={{
                              display: 'inline-block',
                              width: 2.5,
                              height: 17,
                              background: COLORS.mint,
                              verticalAlign: 'middle',
                              marginLeft: 1,
                            }}
                          />
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* LIVE DOCKER SANDBOX TERMINAL */}
              <div
                style={{
                  height: 204,
                  background: '#120a19',
                  borderTop: `1px solid ${COLORS.plumLine}`,
                  padding: '14px 22px',
                  fontFamily: "'Hirearchy Mono', monospace",
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 12,
                  }}
                >
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: COLORS.mint,
                        fontWeight: 600,
                        letterSpacing: '0.1em',
                      }}
                    >
                      TERMINAL · DOCKER SANDBOX
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '2px 8px',
                        borderRadius: 999,
                        background: 'rgba(176,240,206,0.12)',
                        color: COLORS.mint,
                      }}
                    >
                      python:3.12-isolated
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 12,
                      padding: '4px 12px',
                      borderRadius: 6,
                      fontWeight: 650,
                      background:
                        secondPass > 0.2
                          ? 'rgba(126, 230, 176, 0.18)'
                          : firstFail > 0.2
                            ? 'rgba(255, 138, 128, 0.16)'
                            : 'rgba(245,239,230,0.08)',
                      color:
                        secondPass > 0.2
                          ? COLORS.passDark
                          : firstFail > 0.2
                            ? COLORS.failDark
                            : COLORS.onPlumMuted,
                    }}
                  >
                    {secondPass > 0.2
                      ? '✓ 4 PASSED · 0.14s'
                      : firstFail > 0.2
                        ? '✕ 2 FAILED, 1 PASSED'
                        : 'READY'}
                  </span>
                </div>

                <div
                  style={{ fontSize: 13.5, lineHeight: 1.65, color: '#d7cbe0' }}
                >
                  <div>
                    <span style={{ color: COLORS.mint }}>$</span> pytest
                    tests/test_webhooks.py -q
                  </div>
                  {secondPass > 0.2 ? (
                    <>
                      <div style={{ color: COLORS.passDark }}>
                        ✓ test_duplicate_delivery_is_idempotent
                        ........................ PASSED
                      </div>
                      <div style={{ color: COLORS.passDark }}>
                        ✓ test_out_of_order_authorized_after_settled
                        ................... PASSED
                      </div>
                      <div style={{ color: COLORS.passDark }}>
                        ✓ test_refund_after_settled_updates_balance
                        .................... PASSED
                      </div>
                      <div
                        style={{
                          color: COLORS.mint,
                          fontWeight: 650,
                          marginTop: 4,
                        }}
                      >
                        4 passed in 0.14s · Recorded to session chronology (#5)
                      </div>
                    </>
                  ) : firstFail > 0.2 ? (
                    <>
                      <div style={{ color: COLORS.failDark }}>
                        FAILED
                        tests/test_webhooks.py::test_duplicate_delivery_is_idempotent
                        — AssertionError: 10000 == 5000
                      </div>
                      <div style={{ color: COLORS.failDark }}>
                        FAILED
                        tests/test_webhooks.py::test_out_of_order_authorized_after_settled
                        — status regressed to &apos;authorized&apos;
                      </div>
                      <div style={{ color: COLORS.onPlumFaint }}>
                        2 failed, 1 passed in 0.11s · Exit code 1
                      </div>
                    </>
                  ) : (
                    <div style={{ color: COLORS.onPlumFaint }}>
                      Running isolated test suite…
                    </div>
                  )}
                </div>
              </div>

              {/* LIVE WORKSPACE AI DRAWER (Glides in smoothly on right, neutral & logged!) */}
              {aiOpen > 0.01 ? (
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: 472,
                    background: '#22152d',
                    borderLeft: `1px solid rgba(187, 152, 244, 0.32)`,
                    boxShadow: '-24px 0 60px rgba(8, 3, 14, 0.55)',
                    transform: `translate3d(${(1 - aiOpen) * 480}px, 0, 0)`,
                    padding: '22px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                    zIndex: 15,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 16,
                        fontWeight: 650,
                        color: COLORS.onPlum,
                      }}
                    >
                      Workspace AI Assistant
                    </div>
                    <span
                      className="hc-mono"
                      style={{
                        fontSize: 10.5,
                        padding: '4px 9px',
                        borderRadius: 999,
                        background: 'rgba(187, 152, 244, 0.18)',
                        color: COLORS.purple,
                        border: '1px solid rgba(187, 152, 244, 0.36)',
                      }}
                    >
                      LOGGED · NEUTRAL
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: 12.5,
                      color: COLORS.onPlumFaint,
                      lineHeight: 1.45,
                    }}
                  >
                    AI prompts are recorded neutrally in chronology — never
                    penalized, never hidden.
                  </div>

                  {/* Candidate Prompt */}
                  <div
                    style={{
                      padding: '14px 16px',
                      borderRadius: 12,
                      background: '#2c1c39',
                      border: `1px solid ${COLORS.plumLine}`,
                      fontSize: 14,
                      color: COLORS.onPlum,
                      lineHeight: 1.5,
                    }}
                  >
                    <div
                      className="hc-mono"
                      style={{
                        fontSize: 10.5,
                        color: COLORS.mint,
                        marginBottom: 6,
                      }}
                    >
                      ELENA VANCE · +06:48
                    </div>
                    Should an out-of-order{' '}
                    <span className="hc-mono">payment.authorized</span> after{' '}
                    <span className="hc-mono">settled</span> return current
                    status silently or raise ValueError?
                  </div>

                  {/* Kimi Reply */}
                  <div
                    style={{
                      padding: '15px 16px',
                      borderRadius: 12,
                      background: 'rgba(176, 240, 206, 0.08)',
                      border: '1px solid rgba(176, 240, 206, 0.24)',
                      fontSize: 13.8,
                      color: '#ebe3f2',
                      lineHeight: 1.55,
                      opacity: aiReply,
                      transform: `translateY(${(1 - aiReply) * 10}px)`,
                    }}
                  >
                    <div
                      className="hc-mono"
                      style={{
                        fontSize: 10.5,
                        color: COLORS.purple,
                        marginBottom: 6,
                      }}
                    >
                      WORKSPACE AI · RECORDED TURN #1
                    </div>
                    For idempotent webhook processors, return the current
                    monotonic status without mutating ledger balances—raising
                    triggers upstream retry storms. Guard with{' '}
                    <span className="hc-mono" style={{ color: COLORS.mint }}>
                      STATUS_RANK[target] &lt;= STATUS_RANK[payment.status]
                    </span>
                    .
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* IDE Bottom Status Bar — ALL CAPABILITIES ACTIVE */}
          <div
            className="hc-mono"
            style={{
              height: 36,
              background: '#1c1125',
              borderTop: `1px solid ${COLORS.plumLine}`,
              padding: '0 20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 12,
              color: COLORS.onPlumMuted,
            }}
          >
            <div style={{ display: 'flex', gap: 20 }}>
              <span style={{ color: COLORS.mint }}>
                ● Docker Execution: Active
              </span>
              <span style={{ color: COLORS.purple }}>
                ● Workspace AI: Logged
              </span>
              <span>● Chronology Recording</span>
            </div>
            <span>src/webhook_handler.py · UTF-8 · Python 3.12</span>
          </div>

          {/* Cursor gliding to Submit Assessment */}
          <StudioCursor
            x={lerp(1220, 1635, cursorToSubmit)}
            y={lerp(420, 32, cursorToSubmit)}
            opacity={prog(t, 15.35, 15.65) * (1 - prog(t, 16.9, 17.3))}
            clicking={submitClick}
          />
        </div>

        {/* Macro Caption during 2x Zoom — floats cleanly in upper-right quiet space, zero terminal overlap */}
        <div
          style={{
            position: 'absolute',
            right: 96,
            top: 84,
            maxWidth: 640,
            opacity: macro,
            transform: `translateY(${(1 - macro) * -14}px)`,
            background: 'rgba(25, 15, 34, 0.92)',
            border: '1px solid rgba(176, 240, 206, 0.34)',
            boxShadow: '0 24px 64px rgba(6, 2, 12, 0.6)',
            backdropFilter: 'blur(16px)',
            padding: '18px 26px',
            borderRadius: 14,
          }}
        >
          <div
            className="hc-mono"
            style={{
              fontSize: 12.5,
              color: COLORS.mint,
              marginBottom: 6,
              letterSpacing: '0.1em',
            }}
          >
            src/webhook_handler.py · CHECKPOINT v2
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 560,
              color: COLORS.onPlum,
              lineHeight: 1.35,
            }}
          >
            Deduplicate delivery IDs. Enforce forward-only state transitions.
          </div>
        </div>

        {/* Luminous Mint Thread launching out of Submit into Act IV */}
        <ThreadFilament
          d="M 1640 180 C 1760 180 1810 380 1950 510"
          amount={exitThread}
          color={COLORS.mint}
          strokeWidth={3.4}
          opacity={0.9}
        />
      </TactileBackdrop>
    </Curtain>
  );
}
