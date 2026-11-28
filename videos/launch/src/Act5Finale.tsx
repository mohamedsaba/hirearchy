import { Canvas, Cursor, Icon, rise, useBeat } from './film';

export function Act5Finale() {
  const { t, lift, snap, width, height } = useBeat();
  const dissolve = lift(3.18, 3.83);
  const logo = lift(3.38, 4.12);

  return (
    <Canvas
      style={{
        background:
          'radial-gradient(ellipse at 50% 45%, #2D1B36 0%, #211426 62%)',
      }}
    >
      {t < 0.65 && (
        <Cursor
          x={width / 2}
          y={height / 2}
          width={60 * (1 + lift(0, 0.65))}
          height={3}
          opacity={1 - lift(0, 0.65)}
        />
      )}
      {t < 3.85 && (
        <div
          className="principle"
          style={{ opacity: 1 - dissolve, scale: 1 - dissolve * 0.036 }}
        >
          <div>
            <span style={rise(snap(0.2), 32)}>EVIDENCE</span>{' '}
            <span style={rise(snap(0.54), 32)}>INFORMS.</span>
          </div>
          <div>
            <span style={rise(snap(1.27), 32)}>PEOPLE</span>{' '}
            <span style={rise(snap(1.63), 32)}>DECIDE.</span>
          </div>
        </div>
      )}
      <div className="end-card" style={rise(logo, 22)}>
        <div className="wordmark" aria-label="Hirearchy Software">
          <span>Hirearchy</span>
          <b>Software</b>
        </div>
        <div className="end-rule" style={{ scale: `${lift(3.63, 4.24)} 1` }} />
        <div className="end-cta" style={rise(lift(3.94, 4.52), 16)}>
          TRY THE INTERACTIVE DEMO <Icon type="arrow" size={34} />
        </div>
        <div className="end-url" style={rise(lift(4.19, 4.75), 14)}>
          HIREARCHY.IO
        </div>
        <div className="end-offer" style={rise(lift(4.4, 4.91), 14)}>
          EARLY ACCESS OPEN <i /> FIRST 25 TEAMS <i /> 5 EVALUATIONS FREE
        </div>
      </div>
    </Canvas>
  );
}
