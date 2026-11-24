import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  COLORS,
  EASE_CAMERA,
  EASE_EDITORIAL,
  lerp,
  prog,
} from '../tokens';
import {
  BrandWordmark,
  Curtain,
  RevealLine,
  TactileBackdrop,
} from '../components/Primitives';

/**
 * ACT VI — THE COMMON THREAD HORIZON & FINALE (71.0s – 84.0s, local t: 0.0 – 13.0s)
 *   0.0 – 4.3s: Serene Hasselblad macro plate of 3 silk threads (Mint Software · Coral IT · Purple Marketing)
 *               "Different work. One clear principle."
 *   4.3 – 4.8s: Crystalline breath pause
 *   4.8 – 8.6s: Monumental Manifesto: "Evidence informs." / "People decide."
 *   8.6 – 13.0s: Iconic Final Lockup: Hirearchy [Software] · Real work. In context. · Early Access
 */
export function Act6HorizonFinale() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const enter = prog(t, 0.0, 0.85, EASE_CAMERA);
  const horizonOut = prog(t, 4.1, 4.75);

  const family1 = prog(t, 0.55, 1.3);
  const family2 = prog(t, 1.45, 2.2);
  const family3 = prog(t, 2.35, 3.1);

  // Manifesto (after breath 4.3 – 4.8s)
  const mani1 = prog(t, 4.75, 5.65, EASE_EDITORIAL);
  const mani2 = prog(t, 6.05, 7.0, EASE_EDITORIAL);
  const maniOut = prog(t, 8.15, 8.75);

  // Final Lockup (8.55s – 13.0s)
  const lockIn = prog(t, 8.65, 9.6, EASE_EDITORIAL);
  const ctaIn = prog(t, 9.85, 10.65, EASE_EDITORIAL);

  return (
    <Curtain p={enter} from="top">
      <AbsoluteFill>
        {/* LAYER 1: Three-Thread Macro Horizon (0.0 – 4.8s) */}
        <TactileBackdrop
          kind="horizon"
          t={t}
          duration={13.0}
          dim={0.14 + horizonOut * 0.42}
        >
          {/* PHASE 1: HIREARCHY MASTERBRAND HORIZON */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              opacity: 1 - horizonOut,
            }}
          >
            <div style={{ position: 'absolute', left: 124, top: 146, width: 880 }}>
              <div
                className="hc-kicker"
                style={{
                  color: COLORS.mint,
                  marginBottom: 22,
                  opacity: prog(t, 0.25, 0.85),
                }}
              >
                ONE PRINCIPLE · A GROWING FAMILY
              </div>
              <div className="hc-headline" style={{ fontSize: 88, color: COLORS.onPlum }}>
                <RevealLine p={prog(t, 0.35, 1.1)}>Different work.</RevealLine>
                <RevealLine p={prog(t, 0.55, 1.3)}>One clear principle.</RevealLine>
              </div>
            </div>

            {/* Poised Discipline Pills floating gracefully beside the 3 physical silk threads */}
            <div
              style={{
                position: 'absolute',
                left: 124,
                top: 472,
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
              }}
            >
              {[
                {
                  name: 'Hirearchy Software',
                  tag: 'FIRST PRODUCT · LIVE',
                  color: COLORS.mint,
                  p: family1,
                  primary: true,
                },
                {
                  name: 'Hirearchy IT',
                  tag: 'FUTURE HORIZON',
                  color: COLORS.coral,
                  p: family2,
                  primary: false,
                },
                {
                  name: 'Hirearchy Marketing',
                  tag: 'FUTURE HORIZON',
                  color: COLORS.purple,
                  p: family3,
                  primary: false,
                },
              ].map((item) => (
                <div
                  key={item.name}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 16,
                    padding: item.primary ? '16px 24px' : '12px 20px',
                    borderRadius: 14,
                    background: item.primary
                      ? 'rgba(33, 20, 38, 0.86)'
                      : 'rgba(33, 20, 38, 0.58)',
                    border: `1px solid ${item.primary ? 'rgba(176,240,206,0.42)' : 'rgba(245,239,230,0.14)'}`,
                    backdropFilter: 'blur(12px)',
                    opacity: item.p,
                    transform: `translate3d(${(1 - item.p) * -28}px, 0, 0)`,
                    width: 'fit-content',
                  }}
                >
                  <span
                    style={{
                      width: item.primary ? 13 : 10,
                      height: item.primary ? 13 : 10,
                      borderRadius: '50%',
                      background: item.color,
                      boxShadow: item.primary ? `0 0 14px ${item.color}` : 'none',
                    }}
                  />
                  <span
                    style={{
                      fontSize: item.primary ? 26 : 21,
                      fontWeight: item.primary ? 660 : 520,
                      color: item.primary ? COLORS.onPlum : COLORS.onPlumMuted,
                      letterSpacing: '-0.03em',
                    }}
                  >
                    {item.name}
                  </span>
                  <span
                    className="hc-mono"
                    style={{
                      fontSize: 11.5,
                      letterSpacing: '0.12em',
                      color: item.color,
                      marginLeft: 8,
                    }}
                  >
                    {item.tag}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* PHASE 2: MONUMENTAL MANIFESTO (4.75s – 8.75s) */}
          {t >= 4.55 && t <= 9.0 ? (
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
              <div className="hc-headline" style={{ fontSize: 132, color: COLORS.onPlum }}>
                <RevealLine p={mani1}>Evidence informs.</RevealLine>
              </div>
              <div className="hc-headline" style={{ fontSize: 138, color: COLORS.mint, marginTop: 8 }}>
                <RevealLine p={mani2}>People decide.</RevealLine>
              </div>
            </div>
          ) : null}

          {/* PHASE 3: ICONIC FINAL BRAND LOCKUP (8.55s – 13.0s) */}
          {t >= 8.5 ? (
            <TactileBackdrop kind="opening" t={t - 8.5} duration={5.0} dim={0.08}>
              <div
                style={{
                  position: 'absolute',
                  left: 132,
                  top: 238,
                  opacity: lockIn,
                  transform: `translateY(${lerp(24, 0, lockIn)}px)`,
                }}
              >
                <BrandWordmark size={76} dark />
              </div>

              <div
                className="hc-headline"
                style={{
                  position: 'absolute',
                  left: 132,
                  top: 382,
                  fontSize: 94,
                  color: COLORS.onPlum,
                  opacity: lockIn,
                }}
              >
                <RevealLine p={prog(t, 8.95, 9.8)}>Real work.</RevealLine>
                <RevealLine p={prog(t, 9.2, 10.05)}>
                  In context<span style={{ color: COLORS.mint }}>.</span>
                </RevealLine>
              </div>

              <div
                style={{
                  position: 'absolute',
                  left: 134,
                  top: 676,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 20,
                  alignItems: 'flex-start',
                  opacity: ctaIn,
                  transform: `translateY(${lerp(18, 0, ctaIn)}px)`,
                }}
              >
                <div
                  style={{
                    padding: '18px 30px',
                    borderRadius: 12,
                    background: COLORS.mint,
                    color: COLORS.plum,
                    fontSize: 25,
                    fontWeight: 700,
                    letterSpacing: '-0.025em',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 14,
                    boxShadow: '0 20px 54px rgba(176, 240, 206, 0.25)',
                  }}
                >
                  <span>Request Early Access</span>
                  <span>↗</span>
                </div>
                <div
                  className="hc-mono"
                  style={{
                    fontSize: 20,
                    color: COLORS.onPlumMuted,
                    letterSpacing: '0.02em',
                  }}
                >
                  hirearchy.io/products/software
                </div>
              </div>
            </TactileBackdrop>
          ) : null}
        </TactileBackdrop>
      </AbsoluteFill>
    </Curtain>
  );
}
