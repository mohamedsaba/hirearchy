import type { CSSProperties, ReactNode } from 'react';
import { Audio } from '@remotion/media';
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import './first-look.css';

export const firstLookSeconds = 43.2;
const WIDTH = 1920;
const HEIGHT = 1080;
const silk = '#b0f0ce';
const ink = '#291e36';
const paper = '#f5efe6';
const ease = Easing.bezier(0.58, 0.02, 0.22, 1);
const drift = Easing.bezier(0.2, 0.65, 0.24, 1);
const cuts = {
  task: 4.8,
  edit: 9.53,
  trace: 20.43,
  compare: 25.47,
  ask: 31.47,
  close: 36.77,
};

function useTime() {
  const { fps } = useVideoConfig();
  return useCurrentFrame() / fps;
}

export function progress(t: number, start: number, end: number, easing = ease) {
  return interpolate(t, [start, end], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });
}

function ramp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

function asset(name: string) {
  return staticFile(`first-look/${name}`);
}

type Crop = [x: number, y: number, width: number, height: number];

function ProductCrop({
  shot,
  rect: [x, y, width, height],
  style,
  children,
}: {
  shot: string;
  rect: Crop;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div className="fl-crop" style={{ width, height, ...style }}>
      <Img
        style={{
          position: 'absolute',
          left: -x,
          top: -y,
          width: 1440,
          height: 900,
        }}
        src={asset(shot + '.png')}
      />
      {children}
    </div>
  );
}

export function Headline({
  children,
  label,
  progress: entered,
  style,
  className = '',
}: {
  children: ReactNode;
  label?: string;
  progress: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div className={`fl-type ${className}`} style={style}>
      {label && (
        <div className="fl-label" style={{ opacity: entered }}>
          {label}
        </div>
      )}
      <div className="fl-mask">
        <div
          style={{
            transform: `translateY(${(1 - entered) * 108}%)`,
            opacity: entered,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function Filament({
  d,
  amount,
  color = silk,
  width = 3,
  opacity = 1,
}: {
  d: string;
  amount: number;
  color?: string;
  width?: number;
  opacity?: number;
}) {
  if (amount <= 0) return null;
  return (
    <svg
      className="fl-filament"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden="true"
      style={{ opacity }}
    >
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={width}
        pathLength={1}
        strokeDasharray="1 1"
        strokeDashoffset={1 - amount}
        strokeLinecap="round"
      />
    </svg>
  );
}

function Photo({ t, close = false }: { t: number; close?: boolean }) {
  const move = progress(t, 0, close ? 7 : 4.8, drift);
  return (
    <AbsoluteFill className="fl-photo">
      <Img
        src={asset('thread.jpg')}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `translate(${close ? -22 * move : 59 - 71 * move}px, ${close ? 12 * move : -23 * move}px)
          scale(${close ? 1.05 + 0.055 * move : 1.19 - 0.09 * move})`,
          transformOrigin: close ? '83% 52%' : '87% 48%',
        }}
      />
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(90deg, #211426c7 0%, #21142654 41%, transparent 76%)',
        }}
      />
    </AbsoluteFill>
  );
}

export function Opening() {
  const t = useTime();
  const inText = progress(t, 0.12, 1.1, drift);
  const draw = progress(t, 2.65, 4.8);
  return (
    <AbsoluteFill className="fl-night">
      <Photo t={t} />
      <Headline
        label="Introducing Hirearchy Software"
        progress={inText}
        className="fl-open-title"
        style={{ left: 124, top: 302, width: 1070 }}
      >
        Follow
        <br />
        the work<span className="fl-accent">.</span>
      </Headline>
      <Filament
        d="M -24 694 C 240 694 493 694 720 694 C 884 694 970 646 1116 604"
        amount={draw}
        opacity={0.6 * (1 - progress(t, 4.37, 4.8))}
      />
    </AbsoluteFill>
  );
}

function Task() {
  const t = useTime() - 0.47;
  const enter = progress(t, -0.47, 0.65);
  const flow = progress(t, 0, 4.75, drift);
  const tilt = ramp(-3.4, -0.6, enter) + 0.32 * flow;
  return (
    <AbsoluteFill
      className="fl-paper"
      style={{ clipPath: `inset(0 0 0 ${(1 - enter) * 100}%)` }}
    >
      <div className="fl-daylight" />
      <Filament
        d="M -40 702 C 258 702 589 702 765 702 C 942 702 974 762 1263 762 L 2010 762"
        amount={progress(t, -0.18, 2.2)}
        color="#3a7960"
        opacity={0.52}
      />
      <ProductCrop
        shot="builder"
        rect={[151, 105, 1124, 795]}
        style={{
          left: 761 - 32 * flow,
          top: 222 - 29 * flow,
          borderRadius: 24,
          transform: `perspective(2400px) rotateY(${-6 + 4 * flow}deg) rotate(${tilt}deg) scale(${0.98 + 0.12 * flow})`,
          transformOrigin: '16% 38%',
          boxShadow: '0 26px 75px #381f3f27',
          border: '1px solid #b5a3b5',
        }}
      />
      <Headline
        label="Assessment Builder"
        progress={progress(t, 0.13, 0.92, drift)}
        className="fl-task-title"
        style={{ left: 124, top: 310, width: 640 }}
      >
        Start with
        <br />a real task.
      </Headline>
      <div
        className="fl-caption fl-task-caption"
        style={{ opacity: progress(t, 1.1, 1.65), left: 129, top: 756 }}
      >
        A booking needs to move.
        <br />
        What if the new slot is full?
      </div>
    </AbsoluteFill>
  );
}

function Pointer({
  x,
  y,
  opacity = 1,
  scale = 1,
}: {
  x: number;
  y: number;
  opacity?: number;
  scale?: number;
}) {
  return (
    <svg
      width="34"
      height="40"
      viewBox="0 0 34 40"
      style={{
        position: 'absolute',
        left: x,
        top: y,
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: '0 0',
        filter: 'drop-shadow(0 2px 3px #21142673)',
        zIndex: 3,
      }}
    >
      <path
        d="M2 2 30 24l-12 1-5 12Z"
        fill="#f5efe6"
        stroke="#201528"
        strokeWidth="2.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Edit() {
  const t = useTime() - 0.33;
  const intro = progress(t, -0.33, 0.53);
  const local = t + cuts.edit;
  const approach = progress(t, 2.78, 4.35);
  const release = progress(t, 5.78, 7.12);
  const camera = approach * (1 - release);
  const scale = 1.16 + 1.27 * camera;
  const x = ramp(125, -588, camera) + 54 * (1 - intro);
  const lineY = local < 15.23 ? 391 : 424;
  const y = ramp(158, 530 - scale * lineY, camera);
  const step =
    local < 13.78
      ? 'before'
      : local < 15.23
        ? 'selection'
        : local < 17.1
          ? 'edit'
          : local < 19.25
            ? 'save'
            : 'submitted';
  const turnToSubmit = progress(t, 7.8, 9.58);
  const cursor = t > 6.6 && t < 9.86;
  const collect = progress(t, 10.16, 11.25);
  return (
    <AbsoluteFill
      className="fl-night"
      style={{ clipPath: `inset(${(1 - intro) * 100}% 0 0 0)` }}
    >
      <div className="fl-ide-light" />
      <div
        className="fl-topline"
        style={{ opacity: (1 - camera) * progress(t, 0.15, 0.75) }}
      >
        <span>THE CANDIDATE WORKSPACE</span>
        <span>
          Reservation Moves <i>·</i> Demo session
        </span>
      </div>
      <div
        className="fl-edit-frame"
        style={{
          left: x,
          top: y,
          width: 1440 * scale,
          height: 900 * scale,
          borderRadius: ramp(22, 0, camera),
          borderColor: `rgba(176,240,206,${0.32 * (1 - camera)})`,
        }}
      >
        <Img
          src={asset(step + '.png')}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            filter: `brightness(${1.06 + 0.14 * camera})`,
          }}
        />
        {cursor && (
          <Pointer
            x={scale * ramp(1382, 1334, turnToSubmit)}
            y={scale * ramp(86, 26, turnToSubmit)}
            opacity={progress(t, 6.62, 7.12)}
          />
        )}
      </div>
      <div className="fl-ide-vignette" style={{ opacity: camera }} />
      <div
        className="fl-editor-anchor"
        style={{
          left: x + 305 * scale,
          top: y + (lineY + 11) * scale,
          width: 433 * scale * progress(local, 13.2, 14.45),
          opacity: camera * (0.53 + 0.31 * progress(local, 15.23, 15.5)),
        }}
      />
      <div className="fl-macro-caption" style={{ opacity: camera }}>
        <span>src/state.py</span>
        <span>Keep the booking until the destination is checked.</span>
      </div>
      <div
        className="fl-editor-copy"
        style={{
          opacity: progress(t, 0.56, 1.24) * (1 - progress(t, 2.6, 3.2)),
          transform: `translateY(${22 * (1 - progress(t, 0.56, 1.24))}px)`,
        }}
      >
        A repository. An editor. A real change.
      </div>
      <div
        className="fl-submit-copy"
        style={{
          opacity: progress(local, 19.25, 19.58) * (1 - collect),
        }}
      >
        <span /> Work submitted
      </div>
      <Filament
        d="M 232 546 L 950 546 Q 1025 546 1084 601 L 1963 601"
        amount={collect}
        opacity={0.76}
        width={3.2}
      />
    </AbsoluteFill>
  );
}

const traceRows: Crop[] = [
  [67, 424, 492, 88],
  [67, 515, 492, 89],
  [67, 607, 492, 89],
];

function Trace() {
  const t = useTime() - 0.38;
  const enter = progress(t, -0.38, 0.68);
  const focus = progress(t, 3.4, 5.2);
  return (
    <AbsoluteFill style={{ color: ink, overflow: 'hidden' }}>
      <div
        className="fl-daylight"
        style={{
          clipPath: `polygon(${104 - 109 * enter}% 0, 100% 0, 100% 100%, ${114 - 120 * enter}% 100%)`,
        }}
      />
      <Headline
        label="Evidence timeline"
        progress={progress(t, 0.26, 1.15, drift)}
        className="fl-trace-title"
        style={{ left: 124 - focus * 80, top: 317, opacity: 1 - focus * 0.48 }}
      >
        The work
        <br />
        stays in view.
      </Headline>
      <div
        className="fl-caption"
        style={{
          left: 130,
          top: 655,
          opacity: progress(t, 1.07, 1.7) * (1 - focus),
        }}
      >
        Review the candidate’s recorded actions.
      </div>
      <div
        style={{
          position: 'absolute',
          left: 1000 - focus * 180 + (1 - enter) * 145,
          top: 256 - focus * 43,
          transform: `scale(${1 + focus * 0.2})`,
          transformOrigin: '0 223px',
        }}
      >
        <div
          className="fl-real-timeline-label"
          style={{ opacity: progress(t, 0.28, 0.92) }}
        >
          <span>Chronology</span>
          <span>3 recorded events</span>
        </div>
        <div
          style={{
            position: 'absolute',
            left: 18,
            top: 64,
            height: 414 * progress(t, 0.47, 3.15),
            width: 3,
            background: '#47765c',
          }}
        />
        {traceRows.map((rect, index) => {
          const reveal = progress(
            t,
            0.66 + index * 0.53,
            1.28 + index * 0.53,
            drift,
          );
          const selected = index === 1 && t > 1.69;
          return (
            <div
              key={rect[1]}
              style={{
                position: 'absolute',
                left: 50 + 340 * (1 - reveal),
                top: 92 + index * 134 + (1 - reveal) * (155 - index * 63),
                transform: `perspective(1100px) rotateY(${-34 * (1 - reveal)}deg) rotate(${-11 * (1 - reveal)}deg)`,
                opacity: reveal,
              }}
            >
              <span
                className="fl-timeline-pin"
                style={{ background: selected ? '#468565' : paper }}
              />
              <ProductCrop
                shot={t >= 1.69 ? 'timeline-selected' : 'timeline'}
                rect={rect}
                style={{
                  position: 'relative',
                  transform: 'scale(1.39)',
                  transformOrigin: '0 0',
                  borderRadius: 11,
                  boxShadow: selected
                    ? '0 8px 25px #291e3622'
                    : '0 4px 10px #291e3611',
                }}
              />
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

function Compare() {
  const t = useTime() - 0.32;
  const arrive = progress(t, -0.32, 0.64);
  const macro = progress(t, 1.63, 3.16);
  const leave = progress(t, 5.2, 6.28);
  return (
    <AbsoluteFill
      className="fl-paper"
      style={{ clipPath: `inset(${(1 - arrive) * 100}% 0 0 0)` }}
    >
      <div className="fl-daylight" />
      <Headline
        label="Source evidence"
        progress={progress(t, 0.15, 1.03, drift)}
        className="fl-compare-title"
        style={{ left: 126, top: 149 - leave * 40, opacity: 1 - leave }}
      >
        Open the change.
      </Headline>
      <div
        className="fl-caption"
        style={{
          left: 130,
          top: 337,
          opacity: progress(t, 0.87, 1.35) * (1 - leave),
        }}
      >
        The submitted file, compared with the starter.
      </div>
      <ProductCrop
        shot="diff"
        rect={[594, 370, 792, 497]}
        style={{
          left: ramp(712, 455, macro) - leave * 120,
          top: ramp(414, 398, macro) - leave * 160,
          borderRadius: 16,
          transform: `scale(${1.18 + 0.21 * macro})`,
          transformOrigin: '0 0',
          boxShadow: '0 19px 65px #51395c2a',
          border: '1px solid #ae9bb5',
          opacity: (1 - leave * 0.82) * (1 - 0.67 * macro),
        }}
      />
      <ProductCrop
        shot="diff"
        rect={[611, 710, 758, 46]}
        style={{
          left: ramp(661, 124, macro),
          top: ramp(807, 640, macro),
          transform: `scale(${ramp(1.15, 2.19, macro)})`,
          transformOrigin: '0 0',
          opacity: Math.max(0, (macro - 0.27) / 0.73) * (1 - leave),
          borderRadius: 6,
          boxShadow: '0 22px 78px #51395c3b, 0 0 0 1px #bba4ba',
        }}
      />
      <Filament
        d="M -28 902 C 160 902 240 902 354 902 Q 410 902 447 902 L 545 902"
        amount={progress(t, 1.52, 3.08)}
        color="#397157"
        opacity={0.74 * (1 - leave)}
      />
    </AbsoluteFill>
  );
}

function Ask() {
  const t = useTime() - 0.36;
  const reveal = progress(t, 0, 1.13, drift);
  const note = t < 3.49 ? 'note-draft' : 'note';
  const enter = progress(t, 0.34, 1.7);
  return (
    <AbsoluteFill
      style={{
        color: ink,
        background: 'radial-gradient(ellipse at 50% 34%, #f2e9f1, #e6deee 90%)',
        opacity: progress(t, -0.36, 0.44),
      }}
    >
      <ProductCrop
        shot={note}
        rect={[574, 415, 829, 485]}
        style={{
          left: 1030 - 42 * enter,
          top: 384 - 73 * enter,
          transform: `perspective(2300px) rotateY(${8 - 5 * enter}deg) rotate(${-1.7 + 1.5 * enter}deg) scale(${1.03 + 0.09 * enter})`,
          transformOrigin: '0 36%',
          borderRadius: 16,
          border: '1px solid #b7a7bb',
          opacity: enter,
          boxShadow: '0 23px 60px #51395c25',
        }}
      />
      {t > 2.72 && t < 3.54 && (
        <Pointer
          x={ramp(1610, 1792, progress(t, 2.72, 3.44))}
          y={ramp(678, 727, progress(t, 2.72, 3.44))}
          opacity={progress(t, 2.72, 2.93)}
          scale={0.83}
        />
      )}
      <Headline
        label="A reviewer’s question"
        progress={reveal}
        className="fl-question"
        style={{ left: 124, top: 308, width: 880 }}
      >
        “Walk me through
        <br />
        what happens when
        <br />
        the destination is full.”
      </Headline>
      <div
        className="fl-caption"
        style={{ left: 131, top: 774, opacity: progress(t, 2.1, 2.73) }}
      >
        A human observation linked to the source.
      </div>
      <Filament
        d="M 130 733 L 690 733 C 785 733 876 669 985 637 L 1160 637"
        amount={progress(t, 2.4, 4.78)}
        color="#3c745a"
        opacity={0.72}
      />
    </AbsoluteFill>
  );
}

export function Closing() {
  const t = useTime() - 0.3;
  const wipe = progress(t, -0.3, 0.7);
  return (
    <AbsoluteFill
      className="fl-night"
      style={{
        clipPath: `polygon(0 0, 100% 0, 100% ${118 * wipe}%, 0 ${Math.max(0, 118 * wipe - 12)}%)`,
      }}
    >
      <Photo t={t} close />
      <div
        className="fl-wordmark"
        style={{
          opacity: progress(t, 0.08, 0.73),
          transform: `translateY(${15 * (1 - wipe)}px)`,
        }}
      >
        Hirearchy <span>Software</span>
      </div>
      <Headline
        progress={progress(t, 0.22, 1.22, drift)}
        className="fl-close-title"
        style={{ left: 124, top: 369, width: 1160 }}
      >
        See the work behind
        <br />
        the submission.
      </Headline>
      <div className="fl-cta" style={{ opacity: progress(t, 1.44, 2.13) }}>
        <span>
          Join early access <b>↗</b>
        </span>
        <div>www.hirearchy.io/products/software</div>
      </div>
    </AbsoluteFill>
  );
}

export function FirstLook() {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill className="fl-film">
      <Sequence
        from={0}
        durationInFrames={Math.round((cuts.task + 0.72) * fps)}
        name="Follow the Work"
      >
        <Opening />
      </Sequence>
      <Sequence
        from={Math.round((cuts.task - 0.47) * fps)}
        durationInFrames={Math.round((cuts.edit - cuts.task + 0.98) * fps)}
        premountFor={fps}
        name="Reservation Moves"
      >
        <Task />
      </Sequence>
      <Sequence
        from={Math.round((cuts.edit - 0.33) * fps)}
        durationInFrames={Math.round((cuts.trace - cuts.edit + 0.98) * fps)}
        premountFor={fps}
        name="The candidate’s change"
      >
        <Edit />
      </Sequence>
      <Sequence
        from={Math.round((cuts.trace - 0.38) * fps)}
        durationInFrames={Math.round((cuts.compare - cuts.trace + 0.98) * fps)}
        premountFor={fps}
        name="Chronology"
      >
        <Trace />
      </Sequence>
      <Sequence
        from={Math.round((cuts.compare - 0.32) * fps)}
        durationInFrames={Math.round((cuts.ask - cuts.compare + 0.85) * fps)}
        premountFor={fps}
        name="Submitted diff"
      >
        <Compare />
      </Sequence>
      <Sequence
        from={Math.round((cuts.ask - 0.36) * fps)}
        durationInFrames={Math.round((cuts.close - cuts.ask + 0.95) * fps)}
        premountFor={fps}
        name="The next question"
      >
        <Ask />
      </Sequence>
      <Sequence
        from={Math.round((cuts.close - 0.3) * fps)}
        premountFor={fps}
        name="Hirearchy Software"
      >
        <Closing />
      </Sequence>
      <Audio
        src={asset('the-thread.wav')}
        name="Original score and Foley"
        premountFor={fps}
      />
    </AbsoluteFill>
  );
}
