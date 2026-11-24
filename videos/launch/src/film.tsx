import type { CSSProperties, ReactNode } from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const mint = '#8EE3B8';
export const coral = '#E85D56';
export const ease = Easing.bezier(0.22, 1, 0.36, 1);
export const mix = (a: number, b: number, amount: number) =>
  a + (b - a) * amount;

export function useBeat() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const lift = (start: number, end: number) =>
    interpolate(t, [start, end], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: ease,
    });
  const snap = (at: number) =>
    spring({
      frame: frame - Math.round(at * fps),
      fps,
      config: { damping: 18, stiffness: 120 },
    });
  return { t, lift, snap, width, height, tall: height > width };
}

export function rise(amount: number, distance = 28): CSSProperties {
  return {
    opacity: Math.min(1, amount),
    translate: `0 ${distance * (1 - amount)}px`,
  };
}

export function Canvas({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  const { tall } = useBeat();
  return (
    <AbsoluteFill
      className={`film ${tall ? 'portrait' : 'landscape'}`}
      style={style}
    >
      {children}
    </AbsoluteFill>
  );
}

export function Title({
  label,
  children,
  style,
}: {
  label: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <header className="scene-title" style={style}>
      <div className="eyebrow">
        <i />
        {label}
      </div>
      <h1>{children}</h1>
    </header>
  );
}

export function WindowBar({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="window-bar">
      <span className="window-dots">
        <i />
        <i />
        <i />
      </span>
      <span>{children}</span>
      {right && <span className="window-right">{right}</span>}
    </div>
  );
}

export function Cursor({
  x,
  y,
  width = 8,
  height = 42,
  opacity = 1,
  radius = 3,
}: {
  x: number;
  y: number;
  width?: number;
  height?: number;
  opacity?: number;
  radius?: number;
}) {
  return (
    <div
      className="match-cursor"
      style={{ left: x, top: y, width, height, opacity, borderRadius: radius }}
    />
  );
}

export function Icon({
  type,
  size = 24,
}: {
  type:
    | 'stack'
    | 'race'
    | 'spark'
    | 'folder'
    | 'file'
    | 'terminal'
    | 'arrow'
    | 'check'
    | 'comment';
  size?: number;
}) {
  const paths = {
    stack: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
    race: 'M3 12h5l2-7 4 14 2-7h5',
    spark: 'M12 3c0 5 4 9 9 9-5 0-9 4-9 9 0-5-4-9-9-9 5 0 9-4 9-9Z',
    folder: 'M3 6h7l2 2h9v11H3z',
    file: 'M6 3h8l4 4v14H6zM14 3v5h4',
    terminal: 'm5 7 5 5-5 5m8 0h6',
    arrow: 'M4 12h15m-6-6 6 6-6 6',
    check: 'm5 12 4 4L19 6',
    comment: 'M3 4h18v13H9l-6 4zM7 9h10m-10 4h7',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[type]} />
    </svg>
  );
}
