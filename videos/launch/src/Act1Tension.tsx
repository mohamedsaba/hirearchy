import { Canvas, Cursor, coral, rise, useBeat } from './film';

export function Act1Tension() {
  const { t, lift, snap, width, height } = useBeat();
  const clear = lift(6.82, 7.2);
  const glitch =
    t >= 3.0 && t < 3.4 ? Math.sin((t - 3) * 86) * (1 - lift(3.04, 3.4)) : 0;
  const verdict =
    t < 3
      ? 'SAME FINAL CODE.'
      : t < 5
        ? 'ONE COPY-PASTED IN 40 SECONDS.'
        : 'THE OTHER ENGINEERED IT.';
  const since = t < 3 ? 1.62 : t < 5 ? 3 : 5;
  const exit = t < 3 ? lift(2.87, 3) : t < 5 ? lift(4.87, 5) : clear;

  return (
    <Canvas>
      <div
        className="opening"
        style={{ opacity: 1 - clear, scale: 1 - clear * 0.045 }}
      >
        <div className="opening-scores">
          <div
            className="score-card"
            style={{
              ...rise(snap(0.1), 88),
              translate: `${7 * glitch}px ${(1 - snap(0.1)) * 88}px`,
              borderColor: glitch > 0.24 ? coral : undefined,
            }}
          >
            <span className="score-id">
              CANDIDATE A<span />
              <span className="score-dot" />
            </span>
            <strong
              style={{
                textShadow: glitch > 0.15 ? '6px 0 #e85d56' : undefined,
              }}
            >
              100<small>%</small>
            </strong>
          </div>
          <div className="score-card" style={rise(snap(0.26), 88)}>
            <span className="score-id">
              CANDIDATE B<span />
              <span className="score-dot" />
            </span>
            <strong>
              100<small>%</small>
            </strong>
          </div>
        </div>
        <div
          className="verdict"
          key={verdict}
          style={{
            ...rise(snap(since), 32),
            opacity: snap(since) * (1 - exit),
            color: t >= 5 ? 'var(--mint)' : undefined,
          }}
        >
          {verdict}
        </div>
      </div>
      {t >= 6.9 && (
        <Cursor
          x={width / 2}
          y={height / 2}
          opacity={lift(6.9, 7.22) * (0.78 + 0.22 * Math.cos((t - 8) * 9))}
        />
      )}
    </Canvas>
  );
}
