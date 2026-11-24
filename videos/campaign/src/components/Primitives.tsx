import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { COLORS, EASE_CAMERA, EASE_EDITORIAL, lerp, prog } from '../tokens';

/**
 * Masked baseline typography reveal — zero bounce, museum Swiss restraint.
 */
export function RevealLine({
  children,
  p,
  style,
  className = '',
  travel = 106,
}: {
  children: ReactNode;
  p: number;
  style?: CSSProperties;
  className?: string;
  travel?: number;
}) {
  return (
    <div className={`hc-mask ${className}`} style={style}>
      <div
        style={{
          transform: `translate3d(0, ${(1 - p) * travel}%, 0)`,
          opacity: Math.min(1, p * 1.45),
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Editorial Kicker + Headline block.
 */
export function EditorialHeader({
  kicker,
  lines,
  t,
  start = 0.12,
  dark = false,
  size = 78,
  kickerColor,
  style,
}: {
  kicker?: string;
  lines: ReactNode[];
  t: number;
  start?: number;
  dark?: boolean;
  size?: number;
  kickerColor?: string;
  style?: CSSProperties;
}) {
  const kp = prog(t, start, start + 0.55);
  return (
    <div style={style}>
      {kicker ? (
        <div
          className="hc-kicker"
          style={{
            color: kickerColor ?? (dark ? COLORS.mint : COLORS.mintDeep),
            marginBottom: 18,
            opacity: kp,
            transform: `translate3d(0, ${(1 - kp) * 14}px, 0)`,
          }}
        >
          {kicker}
        </div>
      ) : null}
      <div
        className="hc-headline"
        style={{
          fontSize: size,
          color: dark ? COLORS.onPlum : COLORS.ink,
        }}
      >
        {lines.map((line, i) => (
          <RevealLine
            key={i}
            p={prog(t, start + 0.08 + i * 0.14, start + 0.72 + i * 0.14)}
          >
            {line}
          </RevealLine>
        ))}
      </div>
    </div>
  );
}

/**
 * Tactile photographic surface backdrop (warm cotton rag, lilac rag, or deep archival plum).
 */
export function TactileBackdrop({
  kind,
  t = 0,
  duration = 12,
  dim = 0,
  vignette = true,
  children,
}: {
  kind: 'plum' | 'paper' | 'lilac' | 'opening' | 'horizon' | 'vertical';
  t?: number;
  duration?: number;
  dim?: number;
  vignette?: boolean;
  children?: ReactNode;
}) {
  const drift = prog(t, 0, duration, EASE_CAMERA);
  const bgMap: Record<typeof kind, string> = {
    plum: COLORS.plumDeep,
    paper: COLORS.paper,
    lilac: COLORS.lilac,
    opening: COLORS.plumDeep,
    horizon: COLORS.plumDeep,
    vertical: COLORS.plumDeep,
  };
  const plateMap: Partial<Record<typeof kind, string>> = {
    paper: 'plates/paper_daylight.jpg',
    lilac: 'plates/lilac_paper.jpg',
    opening: 'plates/opening_thread.jpg',
    horizon: 'plates/horizon_threads.jpg',
    vertical: 'plates/vertical_thread.jpg',
  };
  const plate = plateMap[kind];
  const isPhoto = kind === 'opening' || kind === 'horizon' || kind === 'vertical';

  return (
    <AbsoluteFill style={{ background: bgMap[kind], overflow: 'hidden' }}>
      {plate ? (
        <Img
          src={staticFile(plate)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: isPhoto ? 1 : 0.88,
            transform: isPhoto
              ? `scale(${lerp(1.07, 1.0, drift)}) translate3d(${lerp(14, -12, drift)}px, ${lerp(6, -6, drift)}px, 0)`
              : `scale(${lerp(1.03, 1.0, drift)})`,
            transformOrigin: kind === 'vertical' ? '50% 68%' : '68% 50%',
          }}
        />
      ) : (
        <AbsoluteFill
          style={{
            background:
              'radial-gradient(ellipse 80% 70% at 62% 28%, #2e1d3c 0%, #1d1127 58%, #150c1d 100%)',
          }}
        />
      )}
      {isPhoto && vignette ? (
        <AbsoluteFill
          style={{
            background:
              kind === 'vertical'
                ? 'linear-gradient(180deg, rgba(22,12,30,0.72) 0%, rgba(22,12,30,0.34) 48%, rgba(22,12,30,0.12) 100%)'
                : 'linear-gradient(90deg, rgba(20,11,28,0.84) 0%, rgba(20,11,28,0.52) 44%, rgba(20,11,28,0.10) 78%, rgba(20,11,28,0.22) 100%)',
          }}
        />
      ) : null}
      {dim > 0 ? (
        <AbsoluteFill style={{ background: `rgba(21, 12, 29, ${dim})` }} />
      ) : null}
      <div className="hc-grain" />
      {children}
    </AbsoluteFill>
  );
}

/**
 * Architectural wipe transition curtain (crisp editorial page turn, never spinning 3D).
 */
export function Curtain({
  p,
  from = 'right',
  children,
}: {
  p: number;
  from?: 'right' | 'left' | 'bottom' | 'top' | 'none';
  children: ReactNode;
}) {
  if (from === 'none') {
    return <AbsoluteFill>{children}</AbsoluteFill>;
  }
  const edge = (1 - p) * 100;
  let clipPath = 'none';
  if (from === 'right') {
    clipPath = `polygon(${edge}% 0%, 100% 0%, 100% 100%, ${Math.min(100, edge * 1.035)}% 100%)`;
  } else if (from === 'left') {
    clipPath = `inset(0 ${edge}% 0 0)`;
  } else if (from === 'bottom') {
    clipPath = `inset(${edge}% 0 0 0)`;
  } else if (from === 'top') {
    clipPath = `inset(0 0 ${edge}% 0)`;
  }
  return <AbsoluteFill style={{ clipPath }}>{children}</AbsoluteFill>;
}

/**
 * Luminous Common Thread animated SVG filament with delicate silk aura.
 */
export function ThreadFilament({
  d,
  amount,
  width = 1920,
  height = 1080,
  color = COLORS.mint,
  strokeWidth = 2.6,
  opacity = 0.82,
  glow = true,
}: {
  d: string;
  amount: number;
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
  opacity?: number;
  glow?: boolean;
}) {
  if (amount <= 0.001) return null;
  const clamped = Math.max(0, Math.min(1, amount));
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity,
      }}
      aria-hidden="true"
    >
      {glow ? (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth * 3.4}
          strokeOpacity={0.14}
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={1 - clamped}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        pathLength={1}
        strokeDasharray="1 1"
        strokeDashoffset={1 - clamped}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Exact Hirearchy Software brand lockup matching the live product masthead.
 */
export function BrandWordmark({
  size = 28,
  dark = true,
  product = 'Software',
  productBg = COLORS.mint,
  style,
}: {
  size?: number;
  dark?: boolean;
  product?: string | null;
  productBg?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: Math.round(size * 0.36),
        ...style,
      }}
    >
      <span
        style={{
          fontSize: size,
          fontWeight: 760,
          letterSpacing: '-0.045em',
          lineHeight: 1,
          color: dark ? COLORS.onPlum : COLORS.ink,
        }}
      >
        Hirearchy
      </span>
      {product ? (
        <span
          style={{
            padding: `${Math.round(size * 0.16)}px ${Math.round(size * 0.34)}px`,
            borderRadius: Math.round(size * 0.22),
            background: productBg,
            color: COLORS.plum,
            fontSize: Math.round(size * 0.44),
            fontWeight: 720,
            letterSpacing: '-0.02em',
            lineHeight: 1.05,
          }}
        >
          {product}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Minimal architectural Studio Pointer cursor with crisp click feedback.
 */
export function StudioCursor({
  x,
  y,
  opacity = 1,
  clicking = false,
}: {
  x: number;
  y: number;
  opacity?: number;
  clicking?: boolean;
}) {
  if (opacity <= 0.01) return null;
  const s = clicking ? 0.86 : 1;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        opacity,
        transform: `scale(${s})`,
        transformOrigin: '2px 2px',
        pointerEvents: 'none',
        zIndex: 40,
      }}
    >
      {clicking ? (
        <div
          style={{
            position: 'absolute',
            left: -14,
            top: -14,
            width: 32,
            height: 32,
            borderRadius: '50%',
            border: `2px solid ${COLORS.mintStrong}`,
            opacity: 0.72,
          }}
        />
      ) : null}
      <svg
        width="26"
        height="31"
        viewBox="0 0 34 40"
        style={{ filter: 'drop-shadow(0 4px 10px rgba(20,10,30,0.35))' }}
      >
        <path
          d="M2.5 2.5 29.5 23.5l-11.5 1.2-4.8 11.8Z"
          fill="#fffdf9"
          stroke="#211426"
          strokeWidth="2.4"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/**
 * Crisp deterministic Python syntax highlighter (100% vector crisp at any zoom!).
 */
const PY_KEYWORDS = new Set([
  'def',
  'if',
  'elif',
  'else',
  'return',
  'in',
  'not',
  'is',
  'None',
  'raise',
  'from',
  'import',
  'class',
  'for',
  'and',
  'or',
]);

const PY_TYPES = new Set([
  'MerchantLedger',
  'WebhookEvent',
  'ValueError',
  'str',
  'int',
  'STATUS_RANK',
  'EVENT_TO_STATUS',
]);

export function PythonLine({
  text,
  theme = 'dark',
}: {
  text: string;
  theme?: 'dark' | 'light';
}) {
  const prefix = theme === 'dark' ? 'py-dark' : 'py-light';
  // Comment handling
  const commentIdx = text.indexOf('#');
  const codePart = commentIdx >= 0 ? text.slice(0, commentIdx) : text;
  const commentPart = commentIdx >= 0 ? text.slice(commentIdx) : '';

  const tokens = codePart.match(
    /(f?"[^"]*"|f?'[^']*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+\b|[^A-Za-z0-9_"']+)/g,
  ) ?? [];

  return (
    <span>
      {tokens.map((tok, i) => {
        if (
          tok.startsWith('"') ||
          tok.startsWith("'") ||
          tok.startsWith('f"') ||
          tok.startsWith("f'")
        ) {
          return (
            <span key={i} className={`${prefix}-str`}>
              {tok}
            </span>
          );
        }
        if (PY_KEYWORDS.has(tok)) {
          return (
            <span key={i} className={`${prefix}-kw`}>
              {tok}
            </span>
          );
        }
        if (PY_TYPES.has(tok)) {
          return (
            <span key={i} className={`${prefix}-type`}>
              {tok}
            </span>
          );
        }
        if (/^\d+$/.test(tok)) {
          return (
            <span key={i} className={`${prefix}-num`}>
              {tok}
            </span>
          );
        }
        if (
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok) &&
          i > 0 &&
          tokens[i - 1]?.trim() === 'def'
        ) {
          return (
            <span key={i} className={`${prefix}-fn`}>
              {tok}
            </span>
          );
        }
        if (
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok) &&
          tokens[i + 1]?.startsWith('(')
        ) {
          return (
            <span key={i} className={`${prefix}-fn`}>
              {tok}
            </span>
          );
        }
        return (
          <span key={i} className={`${prefix}-txt`}>
            {tok}
          </span>
        );
      })}
      {commentPart ? (
        <span className={`${prefix}-cm`}>{commentPart}</span>
      ) : null}
    </span>
  );
}

export function Pill({
  children,
  tone = 'neutral',
  style,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'mint' | 'plum' | 'pass' | 'fail' | 'lilac' | 'darkMint';
  style?: CSSProperties;
}) {
  const styles: Record<typeof tone, CSSProperties> = {
    neutral: {
      background: '#f3ede6',
      color: COLORS.inkSoft,
      border: '1px solid #ddd3c8',
    },
    mint: {
      background: '#e5faef',
      color: COLORS.mintInk,
      border: '1px solid #9fe5c2',
    },
    darkMint: {
      background: 'rgba(176, 240, 206, 0.14)',
      color: COLORS.mint,
      border: '1px solid rgba(176, 240, 206, 0.34)',
    },
    plum: {
      background: COLORS.plum,
      color: COLORS.onPlum,
      border: `1px solid ${COLORS.plum}`,
    },
    lilac: {
      background: COLORS.lilac,
      color: COLORS.plum,
      border: '1px solid #d5c7e5',
    },
    pass: {
      background: COLORS.passBg,
      color: COLORS.pass,
      border: `1px solid ${COLORS.passBorder}`,
    },
    fail: {
      background: COLORS.failBg,
      color: COLORS.fail,
      border: `1px solid ${COLORS.failBorder}`,
    },
  };
  return (
    <span className="hc-pill" style={{ ...styles[tone], ...style }}>
      {children}
    </span>
  );
}

/**
 * Helper to smoothly animate a numeric counter.
 */
export function countUp(target: number, p: number): number {
  return Math.round(target * EASE_EDITORIAL(Math.max(0, Math.min(1, p))));
}
