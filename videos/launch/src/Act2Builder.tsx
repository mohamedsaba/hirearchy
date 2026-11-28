import {
  Canvas,
  Cursor,
  Icon,
  Title,
  WindowBar,
  mix,
  rise,
  useBeat,
} from './film';

export function Act2Builder() {
  const { t, lift, snap, tall, width, height } = useBeat();
  const open = lift(0, 0.66);
  const exit = lift(6.5, 7);
  const flip = snap(3.26);
  const macro = lift(2.65, 3.2) * (1 - lift(3.85, 4.6));
  const switchX = width / 2 + (tall ? 330 : 381);
  const switchY = height / 2 + (tall ? 205 : 163);

  return (
    <Canvas>
      <Title
        label="ASSESSMENT BUILDER"
        style={{
          ...rise(lift(0.16, 0.85)),
          opacity: lift(0.16, 0.85) * (1 - exit),
        }}
      >
        Start with the real work.
      </Title>
      <div
        className="builder-depth"
        style={{ opacity: open * (1 - exit), scale: 0.78 + 0.22 * open }}
      />
      <div
        className="builder-wrap"
        style={{
          opacity: open * (1 - exit),
          transform: `translateX(-50%) perspective(1200px) scale(${0.84 + 0.16 * open + macro * 0.09}) rotateX(${12 * (1 - open) + 4 * macro}deg) rotateY(${-13 * (1 - open) - 5 * macro}deg)`,
        }}
      >
        <div className="window builder">
          <WindowBar right="ROLE-ALIGNED SCENARIO">
            Assessment Builder
          </WindowBar>
          <div className="builder-body">
            <div className="builder-brief">
              <div className="eyebrow">BACKEND ENGINEERING</div>
              <h2>Order fulfilment</h2>
            </div>
            <div className="builder-controls">
              <div className="builder-row" style={rise(snap(0.93), 28)}>
                <span className="ui-icon">
                  <Icon type="stack" />
                </span>
                <div>
                  <label>STACK</label>
                  <strong>Node.js + Redis</strong>
                </div>
              </div>
              <div className="builder-row" style={rise(snap(1.63), 28)}>
                <span className="ui-icon">
                  <Icon type="race" />
                </span>
                <div>
                  <label>SCENARIO</label>
                  <strong>Race condition</strong>
                </div>
              </div>
              <div
                className="builder-row policy"
                style={{
                  ...rise(snap(2.33), 28),
                  borderColor: flip > 0.5 ? 'var(--mint-line)' : undefined,
                }}
              >
                <span className="ui-icon">
                  <Icon type="spark" />
                </span>
                <div>
                  <label>AI ASSISTANT</label>
                  <strong
                    style={{ color: flip > 0.5 ? 'var(--mint)' : undefined }}
                  >
                    {flip > 0.5 ? 'Allowed & logged' : 'Disabled'}
                  </strong>
                </div>
                <div
                  className="toggle"
                  style={{
                    background: flip > 0.5 ? 'var(--mint)' : '#57435e',
                    opacity: 1 - exit,
                  }}
                >
                  <i
                    style={{
                      translate: `${flip * 32}px 0`,
                      background: flip > 0.5 ? 'var(--plum)' : 'var(--cream)',
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        className="tagline"
        style={{
          ...rise(lift(4.12, 4.75)),
          opacity: lift(4.12, 4.75) * (1 - exit),
        }}
      >
        <b>BUILT IN MINUTES.</b> ZERO SENIOR BOTTLENECK.
      </div>
      {t < 0.55 && (
        <Cursor
          x={width / 2}
          y={height / 2}
          width={mix(8, tall ? 850 : 1000, open)}
          height={mix(42, 2, open)}
          opacity={1 - lift(0.12, 0.55)}
        />
      )}
      {t > 6.5 && (
        <Cursor
          x={mix(switchX, width / 2, exit)}
          y={mix(switchY, height / 2, exit)}
          width={mix(70, tall ? 888 : 1380, exit)}
          height={mix(38, 3, exit)}
          radius={mix(19, 2, exit)}
          opacity={0.88}
        />
      )}
    </Canvas>
  );
}
