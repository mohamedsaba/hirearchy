import { CodeRows } from './CodeRows';
import { milestones, sourcePath } from './demo';
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

const stops = [0.46, 1.81, 3.17, 4.55];

export function Act4ChronologyFollowup() {
  const { t, tall, lift, snap, width, height } = useBeat();
  const zoom = lift(5.67, 6.24);
  const outro = lift(11.51, 12);
  const progress =
    (lift(0.52, stops[1]) +
      lift(stops[1] + 0.06, stops[2]) +
      lift(stops[2] + 0.06, stops[3])) /
    3;
  const active = stops.findLastIndex((stop) => t >= stop);
  const index = Math.max(0, active);
  const moment = milestones[index];
  const card = snap(stops[index] - 0.05);
  const firstX = width / 2 - (tall ? 374 : 582);
  const trackY = tall ? 1165 : 737;
  const asked = snap(6.62);
  const answered = snap(7.42);
  const selected = lift(6.31, 6.53);
  const actTitle = t < 6 ? 'Inspect the work.' : 'Ask right on the code.';

  return (
    <Canvas>
      <Title
        label={t < 6 ? 'WORK CHRONOLOGY' : 'ASYNC FOLLOW-UP'}
        style={{
          ...rise(t < 6 ? lift(0.2, 0.65) : lift(6.05, 6.62)),
          opacity:
            t < 6
              ? lift(0.2, 0.65) * (1 - zoom)
              : lift(6.05, 6.62) * (1 - outro),
        }}
      >
        {actTitle}
      </Title>
      {t < 6.25 && (
        <div className="chronology" style={{ opacity: 1 - zoom }}>
          <div
            className="window moment-card"
            key={moment.time}
            style={{
              ...rise(card),
              transform: `perspective(1200px) rotateX(${4 * (1 - card)}deg) scale(${1 + zoom * 0.11})`,
            }}
          >
            <div className="moment-top">
              <span className="logged">
                <i /> ILLUSTRATIVE RUN
              </span>
              <span className="timecode">{moment.time}</span>
            </div>
            <div className="moment-body">
              <span className="moment-icon">
                <Icon type={moment.icon} size={37} />
              </span>
              <div>
                <div className="eyebrow">{moment.kind}</div>
                <h2>{moment.title}</h2>
                <p>{moment.detail}</p>
              </div>
            </div>
            {index === 3 && (
              <div className="moment-code">
                <CodeRows start={7} end={7} highlight={7} />
              </div>
            )}
          </div>
          <div className="timeline" style={{ opacity: lift(0, 0.38) }}>
            <div className="rail">
              <div
                className="rail-progress"
                style={{ width: `${progress * 100}%` }}
              />
              <div className="rail-ticks" />
              <b
                className="rail-caret"
                style={{ left: `${progress * 100}%` }}
              />
            </div>
            {milestones.map((entry, i) => (
              <div
                key={entry.time}
                className={`stop stop-${i} ${i <= index ? 'stop-seen' : ''}`}
              >
                <i />
                <span>{entry.time}</span>
                <strong>{entry.title}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
      {t < 0.38 && (
        <Cursor
          x={firstX}
          y={trackY}
          width={3}
          height={64}
          opacity={1 - lift(0.04, 0.38)}
        />
      )}
      {t >= 5.67 && (
        <div
          className="followup-wrap"
          style={{
            opacity: zoom * (1 - outro),
            transform: `translateX(-50%) perspective(1200px) scale(${0.92 + 0.08 * zoom - 0.19 * outro}) rotateX(${(1 - zoom) * 6 + 12 * outro}deg)`,
          }}
        >
          <div className="window followup">
            <WindowBar right="LINE-ANCHORED">{sourcePath}</WindowBar>
            <div className="followup-code">
              <CodeRows start={5} end={8} highlight={selected > 0.2 ? 7 : 0} />
              <div
                className="line-pin"
                style={{ opacity: selected, scale: 0.7 + 0.3 * selected }}
              >
                <Icon type="comment" size={23} />
              </div>
              {t > 6.22 && t < 6.83 && (
                <div
                  className="pointer"
                  style={{
                    translate: `${mix(70, 0, selected)}px ${mix(45, 0, selected)}px`,
                    opacity: lift(6.22, 6.4) * (1 - lift(6.64, 6.83)),
                  }}
                >
                  ➤
                </div>
              )}
            </div>
            <div className="thread">
              <div className="thread-meta" style={rise(asked, 12)}>
                <span className="line-anchor">LINE 7</span> ILLUSTRATIVE THREAD
              </div>
              <div className="message" style={rise(asked, 22)}>
                <span className="avatar">E</span>
                <div>
                  <label>EVALUATOR</label>
                  <p>Why Redis lock with TTL here?</p>
                </div>
              </div>
              <div className="message reply" style={rise(answered, 24)}>
                <span className="avatar">C</span>
                <div>
                  <label>CANDIDATE</label>
                  <p>Prevents double writes under concurrent retries.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <div
        className="tagline"
        style={{
          ...rise(lift(9.03, 9.55)),
          opacity: lift(9.03, 9.55) * (1 - outro),
        }}
      >
        <b>3-MINUTE REVIEW.</b> SKIP THE EXTRA INTERVIEW.
      </div>
      {t > 11.51 && (
        <Cursor
          x={width / 2}
          y={mix(tall ? 1100 : 650, height / 2, outro)}
          width={mix(tall ? 760 : 972, 60, outro)}
          height={3}
          opacity={outro}
        />
      )}
    </Canvas>
  );
}
