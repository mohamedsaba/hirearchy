import type { ReactNode } from 'react';
import { Audio } from '@remotion/media';
import {
  Easing,
  Series,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { CodeRows } from './CodeRows';
import {
  checks,
  fixedCode,
  milestones,
  originalCode,
  repoFiles,
  sourcePath,
} from './demo';
import { Canvas, Cursor, Icon, WindowBar, mix } from './film';
import './lead-gen.css';

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const paper = '#F5EFE6';

function useCut() {
  const frame = useCurrentFrame();
  const { fps, height, width } = useVideoConfig();
  const t = frame / fps;
  const move = (from: number, to: number) =>
    interpolate(t, [from, to], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: easeOut,
    });
  const hit = (at: number) =>
    spring({
      frame: frame - Math.round(at * fps),
      fps,
      config: { damping: 14, stiffness: 200, mass: 0.7 },
    });
  return { t, frame, move, hit, tall: height > width, height, width };
}

function wipe(
  amount: number,
  edge: 'center' | 'bottom' = 'center',
  pivot = 50,
) {
  const cut = Math.max(0, (1 - amount) * 50);
  return edge === 'center'
    ? `inset(${(cut * pivot) / 50}% 0 ${(cut * (100 - pivot)) / 50}% round 20px)`
    : `inset(${cut * 2}% 0 0 round 20px)`;
}

function Heading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <header className="lead-heading">
      <p>{label}</p>
      <h1>{children}</h1>
    </header>
  );
}

function Hook() {
  const { t, width, height, hit, move } = useCut();
  const split = move(2.22, 2.56);
  const collapse = move(5.2, 5.61);
  const first = hit(0.08);
  const second = hit(0.6);

  return (
    <>
      {t < 2.67 && (
        <div className="lead-hook">
          <div
            className="lead-hook-line"
            style={{
              clipPath: `inset(0 0 ${Math.max(0, (1 - first) * 100)}% 0)`,
              translate: `0 ${-(split * 187 + (1 - first) * 60)}px`,
            }}
          >
            BAD HIRES
          </div>
          <div
            className="lead-hook-line"
            style={{
              clipPath: `inset(${Math.max(0, (1 - second) * 100)}% 0 0 0)`,
              translate: `0 ${split * 187 + (1 - second) * 60}px`,
            }}
          >
            COST <em>MONTHS.</em>
          </div>
        </div>
      )}
      {t >= 2.26 && t < 5.62 && (
        <div
          className="lead-pains"
          style={{
            clipPath: wipe(1 - collapse),
            scale: `${1 - 0.42 * collapse} ${1 - 0.9 * collapse}`,
          }}
        >
          <div
            className="lead-pain"
            style={{
              clipPath: `inset(0 ${Math.max(0, (1 - hit(2.4)) * 100)}% 0 0 round 12px)`,
            }}
          >
            <span>TRIVIA TESTS</span>
            <b>LOSE GREAT DEVS.</b>
          </div>
          <div
            className="lead-pain"
            style={{
              clipPath: `inset(0 0 0 ${Math.max(0, (1 - hit(2.79)) * 100)}% round 12px)`,
            }}
          >
            <span>100% SCORES</span>
            <b>HIDE THE WORK.</b>
          </div>
        </div>
      )}
      {t >= 5.43 && (
        <Cursor
          x={width / 2}
          y={height / 2}
          width={mix(132, 9, move(5.43, 5.65))}
          height={mix(7, 52, move(5.43, 5.65))}
          opacity={0.85 + 0.15 * Math.cos((t - 6) * 15)}
        />
      )}
    </>
  );
}

function ProjectFiles() {
  return (
    <div className="lead-file-workspace">
      <aside>
        <div className="lead-micro">EXPLORER</div>
        <div className="lead-folder">
          <Icon type="folder" size={19} /> order-fulfilment
        </div>
        {repoFiles.map((file) => (
          <div
            className={file === sourcePath ? 'lead-file chosen' : 'lead-file'}
            key={file}
          >
            <Icon type="file" size={17} />
            {file}
          </div>
        ))}
      </aside>
      <div className="lead-file-editor">
        <div className="lead-editor-tab">
          <Icon type="file" size={20} />
          {sourcePath}
        </div>
        <CodeRows lines={originalCode} start={3} end={9} />
      </div>
    </div>
  );
}

function LeadTerminal({ passed, shown }: { passed: boolean; shown: number }) {
  return (
    <div className="lead-terminal">
      <div className="lead-terminal-column">
        <div className="lead-micro">
          <Icon type="terminal" size={22} /> TERMINAL <span>SAMPLE RUN</span>
        </div>
        <p className="lead-command">
          <b>$</b> npm test -- fulfil-order
        </p>
        {checks.map((check, index) => (
          <p
            className="lead-terminal-result"
            key={check}
            style={{ visibility: shown > index ? 'visible' : 'hidden' }}
          >
            <b className={passed ? 'lead-pass' : 'lead-fail'}>
              {passed ? 'PASS' : 'FAIL'}
            </b>
            {check}
          </p>
        ))}
      </div>
      <div className="lead-terminal-code">
        <div className="lead-editor-tab">
          <Icon type="file" size={20} />
          {sourcePath}
        </div>
        <CodeRows
          lines={passed ? fixedCode : originalCode}
          start={5}
          end={8}
          highlight={passed ? 7 : 0}
        />
      </div>
    </div>
  );
}

function Workspace() {
  const { t, frame, tall, width, height, hit, move } = useCut();
  const intro = move(0, 0.42);
  const exit = move(7.5, 8);
  const passed = frame >= 243;
  const terminal = t >= 2.34;
  const aiPanel = t >= 4.58;
  const flipped = frame >= 353;
  const knob = hit(5.78);
  const count = Math.min(3, Math.max(0, Math.floor((frame - 153) / 5) + 1));
  const status = passed ? '3 PASSED' : '3 FAILED';

  return (
    <>
      <div
        className="lead-reveal-header"
        style={{ clipPath: wipe(intro * (1 - exit)) }}
      >
        <Heading label="CANDIDATE WORKSPACE">Real work. Real tools.</Heading>
      </div>
      <div
        className="lead-ide lead-dark"
        style={{
          clipPath: wipe(intro * (1 - exit)),
          scale: 0.95 + intro * 0.05,
        }}
      >
        <WindowBar right="NODE.JS + REDIS">Candidate Workspace</WindowBar>
        <div className="lead-ide-picture">
          {!terminal && <ProjectFiles />}
          {terminal && !aiPanel && (
            <div
              className="lead-pane"
              style={{ clipPath: wipe(move(2.34, 2.62), 'bottom') }}
            >
              <LeadTerminal passed={passed} shown={count} />
            </div>
          )}
          {aiPanel && (
            <div
              className="lead-pane lead-ai"
              style={{
                clipPath: `inset(0 0 0 ${(1 - move(4.58, 4.9)) * 100}%)`,
              }}
            >
              <div className="lead-ai-copy">
                <span className="lead-micro">
                  <Icon type="spark" size={22} /> AI ASSISTANT
                </span>
                <h2>Allowed &amp; logged</h2>
                <p>How should I structure a Redis lock with TTL here?</p>
              </div>
              <div className="lead-ai-control">
                <div
                  className={`lead-switch ${flipped ? 'on' : ''}`}
                  style={{ scale: 1 + 0.17 * (knob - Math.min(1, knob)) }}
                >
                  <i style={{ translate: `${Math.min(1, knob) * 49}px 0` }} />
                </div>
                <span className="lead-micro">
                  {flipped ? 'PROMPTS IN THE RECORD' : 'ASSESSMENT POLICY'}
                </span>
              </div>
            </div>
          )}
        </div>
        <div
          className={`lead-run-bar ${passed ? 'verified' : terminal && count ? 'failing' : ''}`}
        >
          <span>
            <Icon type={passed ? 'check' : 'terminal'} size={24} />{' '}
            {terminal && count ? status : 'INTEGRATED TERMINAL'}
          </span>
          {terminal && count > 0 && <span>SAMPLE CHECKS</span>}
        </div>
      </div>
      {t >= 5.98 && (
        <div
          className="lead-callout workspace-callout"
          style={{ clipPath: wipe(move(5.98, 6.29) * (1 - exit)) }}
        >
          NO WEBCAM PROCTORING. NO BLANKET AI BANS. <b>REAL WORK.</b>
        </div>
      )}
      {t < 0.42 && (
        <Cursor
          x={width / 2}
          y={height / 2}
          width={mix(9, tall ? 906 : 1430, intro)}
          height={mix(52, 3, intro)}
          opacity={1 - move(0.16, 0.42)}
        />
      )}
      {t >= 7.5 && (
        <div
          className="lead-match-bar"
          style={{
            top: mix(tall ? 1287 : 750, height / 2, exit),
            width: mix(tall ? 866 : 1390, tall ? 930 : 1370, exit),
            height: mix(62, 5, exit),
            borderRadius: mix(10, 3, exit),
          }}
        >
          <span style={{ clipPath: wipe(1 - move(7.5, 7.7)) }}>3 PASSED</span>
        </div>
      )}
    </>
  );
}

function Setup() {
  const { t, height, tall, width, hit, move } = useCut();
  const open = move(0, 0.39);
  const exit = move(2.63, 3);
  const stage = open * (1 - exit);
  const nextX = width / 2 - (tall ? 379 : 549);
  const nextY = tall ? 1168 : 720;

  return (
    <>
      <div className="lead-reveal-header" style={{ clipPath: wipe(stage) }}>
        <Heading label="ASSESSMENT BUILDER">Start with the actual job.</Heading>
      </div>
      <div
        className="lead-setup lead-paper-card"
        style={{ clipPath: wipe(stage), scale: 0.96 + 0.04 * open }}
      >
        <div className="lead-paper-bar">
          <span>Assessment Builder</span>
          <span>BACKEND ENGINEERING</span>
        </div>
        <h2>Order fulfilment</h2>
        <div className="lead-pills">
          <div style={{ scale: hit(0.21) }}>
            <Icon type="stack" size={26} />
            <strong>NODE.JS</strong>
          </div>
          <div style={{ scale: hit(0.66) }}>
            <Icon type="race" size={26} />
            <strong>RACE CONDITION</strong>
          </div>
          <div style={{ scale: hit(1.21) }}>
            <Icon type="spark" size={26} />
            <strong>AI: LOGGED</strong>
          </div>
        </div>
      </div>
      <div
        className="lead-callout"
        style={{ clipPath: wipe(move(0.88, 1.23) * (1 - exit)) }}
      >
        <b>BUILT IN MINUTES.</b> SAVE SENIOR ENGINEERING TIME.
      </div>
      {t < 0.38 && (
        <div
          className="lead-match-bar"
          style={{
            top: height / 2,
            width: tall ? 930 : 1370,
            height: 5,
            opacity: 1 - open,
          }}
        />
      )}
      {t > 2.63 && (
        <Cursor
          x={mix(width / 2, nextX, exit)}
          y={mix(height / 2, nextY, exit)}
          width={mix(tall ? 930 : 1370, 4, exit)}
          height={mix(5, 51, exit)}
        />
      )}
    </>
  );
}

const leadStops = [0.3, 1.33, 2.2, 4.33];
const leadLabels = ['Repo', 'Failed', 'AI Prompt Logged', 'Verified'];

function Chronology() {
  const { t, width, tall, hit, move } = useCut();
  const sceneIn = move(0, 0.37);
  const match = move(4.62, 5);
  const index = Math.max(
    0,
    leadStops.findLastIndex((stop) => t >= stop),
  );
  const moment = milestones[index];
  const progress =
    (move(0.73, leadStops[1]) +
      move(1.72, leadStops[2]) +
      move(3.95, leadStops[3])) /
    3;
  const entry = hit(leadStops[index]);

  return (
    <>
      <div
        className="lead-reveal-header"
        style={{ clipPath: wipe(sceneIn * (1 - match)) }}
      >
        <Heading label="WORK CHRONOLOGY">See the steps scores miss.</Heading>
      </div>
      <div className="lead-chronology">
        <div
          key={index}
          className="lead-moment lead-paper-card"
          style={{
            clipPath: wipe(entry * (1 - match), 'bottom'),
            scale: 0.965 + 0.035 * entry,
          }}
        >
          <div className="lead-paper-bar">
            <span>Illustrative run</span>
            <span>{moment.time}</span>
          </div>
          <div className="lead-moment-content">
            <span className={index === 1 ? 'bad' : ''}>
              <Icon type={moment.icon} size={38} />
            </span>
            <div>
              <h2>{index === 2 ? leadLabels[index] : moment.title}</h2>
              <p>{moment.detail}</p>
            </div>
          </div>
        </div>
        <div
          className="lead-timeline"
          style={{
            clipPath: `inset(0 ${100 - sceneIn * 110}% ${match * 100}% -95px)`,
          }}
        >
          <div className="lead-rail">
            <i style={{ width: `${progress * 100}%` }} />
            <b style={{ left: `${progress * 100}%` }} />
          </div>
          {leadLabels.map((label, i) => (
            <div
              className={`lead-stop ${i <= index ? 'active' : ''}`}
              key={label}
              style={{ left: `${(i / 3) * 100}%` }}
            >
              <i />
              <span>{milestones[i].time}</span>
              <b>{label}</b>
            </div>
          ))}
        </div>
      </div>
      {t < 0.28 && (
        <Cursor
          x={width / 2 - (tall ? 379 : 549)}
          y={tall ? 1168 : 720}
          width={4}
          height={51}
          opacity={1 - sceneIn}
        />
      )}
      {t >= 4.62 && (
        <div
          className="lead-code-match lead-dark"
          style={{ scale: `1 ${mix(0.28, 1, match)}`, clipPath: wipe(match) }}
        >
          <CodeRows start={7} end={7} highlight={7} />
        </div>
      )}
    </>
  );
}

function FollowUp() {
  const { t, width, height, tall, hit, move } = useCut();
  const reveal = move(0, 0.34);
  const fold = move(3.38, 3.65);
  const question = hit(0.64);
  const reply = hit(1.44);

  return (
    <>
      <div
        className="lead-reveal-header"
        style={{ clipPath: wipe(reveal * (1 - fold)) }}
      >
        <Heading label="ASYNC FOLLOW-UP">Ask at the line.</Heading>
      </div>
      <div
        className="lead-follow lead-dark"
        style={{
          clipPath: wipe(reveal * (1 - fold), 'center', tall ? 30 : 34),
          scale: `1 ${1 - fold * 0.66}`,
        }}
      >
        <WindowBar right="LINE 7">{sourcePath}</WindowBar>
        <CodeRows start={5} end={8} highlight={7} />
        <div className="lead-thread">
          <div className="lead-micro">ILLUSTRATIVE THREAD</div>
          <div
            className="lead-bubble"
            style={{ clipPath: wipe(question), scale: 0.94 + 0.06 * question }}
          >
            <label>EVALUATOR</label>
            <strong>Why Redis lock here?</strong>
          </div>
          <div
            className="lead-bubble reply"
            style={{ clipPath: wipe(reply), scale: 0.94 + 0.06 * reply }}
          >
            <label>CANDIDATE</label>
            <strong>Prevents double writes.</strong>
          </div>
        </div>
      </div>
      <div
        className="lead-callout"
        style={{ clipPath: wipe(move(1.73, 2.03) * (1 - fold)) }}
      >
        <b>3-MINUTE REVIEW.</b> SKIP THE EXTRA CALL.
      </div>
      {t < 0.34 && (
        <div
          className="lead-code-match lead-dark"
          style={{ clipPath: wipe(1 - reveal) }}
        >
          <CodeRows start={7} end={7} highlight={7} />
        </div>
      )}
      {t > 3.4 && (
        <Cursor
          x={width / 2}
          y={mix(tall ? 945 : 535, height / 2, fold)}
          width={mix(tall ? 880 : 1140, 102, fold)}
          height={5}
        />
      )}
    </>
  );
}

function EndCard() {
  const { t, width, height, tall, hit, move } = useCut();
  const sloganAt = t < 1.88 ? 0.04 : 1.88;
  const slogan = hit(sloganAt);
  const swap = t < 1.88 ? move(1.69, 1.88) : move(4.03, 4.3);
  const brand = hit(4.3);

  return (
    <>
      {t < 4.31 && (
        <div
          key={sloganAt}
          className="lead-manifesto"
          style={{
            clipPath: wipe(slogan * (1 - swap)),
            scale: 0.93 + 0.07 * slogan,
          }}
        >
          {t < 1.88 ? (
            'STOP GUESSING.'
          ) : (
            <>
              SEE THE <em>WORK.</em>
            </>
          )}
        </div>
      )}
      {t < 0.25 && (
        <Cursor
          x={width / 2}
          y={height / 2}
          width={mix(102, tall ? 780 : 1220, move(0, 0.25))}
          height={5}
          opacity={1 - move(0.06, 0.25)}
        />
      )}
      {t >= 4.29 && (
        <div
          className="lead-lockup"
          style={{ clipPath: wipe(brand), scale: 0.9 + brand * 0.1 }}
        >
          <div className="wordmark" aria-label="Hirearchy Software">
            <span>Hirearchy</span>
            <b>Software</b>
          </div>
          <div className="lead-cta" style={{ clipPath: wipe(hit(4.58)) }}>
            GET EARLY ACCESS <Icon type="arrow" size={34} /> HIREARCHY.IO
          </div>
          <div className="lead-end-sub">
            BUILT FOR MODERN ENGINEERING TEAMS.
          </div>
        </div>
      )}
    </>
  );
}

export function LeadGen() {
  const { fps } = useVideoConfig();
  return (
    <Canvas style={{ background: paper }}>
      <div className="lead-grain" />
      <div className="lead-film">
        <Series>
          <Series.Sequence
            name="The double pain"
            durationInFrames={6 * fps}
            premountFor={fps}
          >
            <Hook />
          </Series.Sequence>
          <Series.Sequence
            name="The candidate win"
            durationInFrames={8 * fps}
            premountFor={fps}
          >
            <Workspace />
          </Series.Sequence>
          <Series.Sequence
            name="Assessment setup"
            durationInFrames={3 * fps}
            premountFor={fps}
          >
            <Setup />
          </Series.Sequence>
          <Series.Sequence
            name="Work chronology"
            durationInFrames={5 * fps}
            premountFor={fps}
          >
            <Chronology />
          </Series.Sequence>
          <Series.Sequence
            name="Line 7 follow-up"
            durationInFrames={4 * fps}
            premountFor={fps}
          >
            <FollowUp />
          </Series.Sequence>
          <Series.Sequence
            name="Get early access"
            durationInFrames={9 * fps}
            premountFor={fps}
          >
            <EndCard />
          </Series.Sequence>
        </Series>
      </div>
      <Audio
        name="35s mastered mix"
        src={staticFile('lead-gen-master.wav')}
        premountFor={fps}
      />
    </Canvas>
  );
}
