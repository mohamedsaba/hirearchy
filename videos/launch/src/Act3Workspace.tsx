import { CodeRows } from './CodeRows';
import {
  checks,
  fixedCode,
  originalCode,
  prompt,
  repoFiles,
  sourcePath,
} from './demo';
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

function AiExchange({ focus }: { focus: number }) {
  const { lift } = useBeat();
  return (
    <div
      className="assistant-panel"
      style={{ borderColor: focus > 0.25 ? 'var(--mint-line)' : undefined }}
    >
      <div className="assistant-label">
        <Icon type="spark" size={26} /> AI Assistant
      </div>
      <div className="logged">
        <i /> TRANSPARENTLY LOGGED
      </div>
      <div className="prompt-bubble" style={rise(lift(2.48, 2.95), 15)}>
        {prompt}
      </div>
      <div className="assistant-response" style={rise(lift(3.15, 3.65), 13)}>
        Acquire with <b>SET NX</b> and a TTL. Release only if the ownership
        token still matches.
      </div>
    </div>
  );
}

function Terminal() {
  const { t, lift } = useBeat();
  const failed = t >= 4.85;
  const patched = t >= 6.18;
  const passed = t >= 7.24;
  const running = patched && !passed;
  const status = passed ? 'pass' : running || !failed ? 'pending' : 'fail';
  const output = passed
    ? '3 PASSED'
    : running
      ? 'RE-RUNNING'
      : failed
        ? '3 FAILED'
        : 'READY';
  const ripple = lift(7.24, 8.15);

  return (
    <div className="terminal">
      <div className="terminal-header">
        <span>
          <Icon type="terminal" size={25} /> Terminal
        </span>
        <span className="micro">SAMPLE RUN</span>
      </div>
      <div className="terminal-grid">
        <div className="terminal-lines">
          <div className="terminal-command">
            <em>$</em> npm test -- fulfil-order
            <span className="terminal-caret" />
          </div>
          {checks.map((check, index) => (
            <div
              className="terminal-result"
              style={{
                opacity: failed
                  ? lift(4.85 + index * 0.09, 5.03 + index * 0.09)
                  : 0.24,
              }}
              key={check}
            >
              <b className={status}>
                {passed ? 'PASS' : running || !failed ? '····' : 'FAIL'}
              </b>
              <span>{check}</span>
            </div>
          ))}
        </div>
        <div
          className={`result-badge ${status}`}
          style={{ scale: passed ? 1 + (1 - ripple) * 0.08 : 1 }}
        >
          {output}
          {passed && (
            <i
              style={{ opacity: (1 - ripple) * 0.7, scale: 1 + ripple * 0.37 }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function Act3Workspace() {
  const { t, tall, lift, width } = useBeat();
  const enter = lift(0, 0.54);
  const exit = lift(8.54, 9);
  const ai = lift(2.03, 2.59) * (1 - lift(4.02, 4.43));
  const terminal = lift(4.04, 4.66);
  const patched = t >= 6.18;
  const trackX = width / 2 - (tall ? 374 : 582);
  const trackY = tall ? 1165 : 737;

  return (
    <Canvas>
      <Title
        label="CANDIDATE WORKSPACE"
        style={{
          ...rise(lift(0.16, 0.62)),
          opacity: lift(0.16, 0.62) * (1 - exit),
        }}
      >
        Work in the real stack.
      </Title>
      <div
        className="workspace-camera"
        style={{
          opacity: enter * (1 - exit) * (1 - 0.87 * Math.max(ai, terminal)),
          transform: `translateX(-50%) translate(${ai * (tall ? 45 : -155)}px, ${-terminal * (tall ? 82 : 52)}px) perspective(1200px) scale(${0.93 + 0.07 * enter + ai * 0.12 + terminal * 0.08}) rotateY(${(1 - enter) * 7 - ai * 5}deg)`,
        }}
      >
        <div className="window workspace">
          <WindowBar right="NODE.JS + REDIS">Candidate Workspace</WindowBar>
          <div className="workspace-main">
            <div className="explorer">
              <div className="micro">EXPLORER</div>
              <div className="file-folder">
                <Icon type="folder" size={19} /> order-fulfilment
              </div>
              {repoFiles.map((file) => (
                <div
                  className={`file-row ${file === sourcePath ? 'is-active' : ''}`}
                  key={file}
                >
                  <Icon type="file" size={17} />
                  {file}
                </div>
              ))}
            </div>
            <div className="editor">
              <div className="editor-tab">
                <Icon type="file" size={19} />
                {sourcePath}
                {patched && <b className="patch-mark">M</b>}
              </div>
              <CodeRows
                lines={patched ? fixedCode : originalCode}
                highlight={patched ? 7 : 0}
              />
            </div>
            <AiExchange focus={ai} />
          </div>
          <Terminal />
        </div>
      </div>
      {ai > 0 && (
        <div
          className="window ai-macro"
          style={{
            opacity: ai,
            transform: `translateX(-50%) translateX(${(1 - ai) * (tall ? 36 : 230)}px) perspective(1200px) rotateY(${(1 - ai) * -12}deg) scale(${0.82 + 0.18 * ai})`,
          }}
        >
          <AiExchange focus={ai} />
        </div>
      )}
      {terminal > 0 && (
        <div
          className="window terminal-macro"
          style={{
            opacity: terminal * (1 - exit),
            transform: `translateX(-50%) translateY(${(1 - terminal) * (tall ? 125 : 95)}px) perspective(1200px) rotateX(${(1 - terminal) * 8}deg) scale(${0.83 + 0.17 * terminal - exit * 0.09})`,
          }}
        >
          <div className="editor-tab">
            <Icon type="file" size={21} />
            {sourcePath}
            {patched && <b className="patch-mark">M</b>}
          </div>
          <CodeRows
            lines={patched ? fixedCode : originalCode}
            start={5}
            end={8}
            highlight={patched ? 7 : 0}
          />
          <Terminal />
        </div>
      )}
      {t < 0.55 && (
        <Cursor
          x={width / 2}
          y={tall ? 960 : 540}
          width={mix(tall ? 888 : 1380, 60, enter)}
          height={3}
          opacity={0.88 * (1 - enter)}
        />
      )}
      {t > 8.54 && (
        <Cursor
          x={mix(width / 2 - (tall ? 65 : 177), trackX, exit)}
          y={mix(tall ? 1004 : 596, trackY, exit)}
          width={mix(7, 3, exit)}
          height={mix(27, 64, exit)}
          opacity={Math.max(0.2, exit)}
        />
      )}
    </Canvas>
  );
}
