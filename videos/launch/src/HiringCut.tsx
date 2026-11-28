import type { ReactNode } from 'react';
import { Audio } from '@remotion/media';
import {
  AbsoluteFill,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { Closing, Filament, Headline, Opening, progress } from './FirstLook';
import './hiring-cut.css';

export const hiringCutSeconds = 68;

type Crop = [number, number, number, number];
type Tone = 'paper' | 'plum' | 'lilac' | 'mint';

const overlap = 0.42;

function useLocalTime() {
  const { fps } = useVideoConfig();
  return useCurrentFrame() / fps - overlap;
}

function Surface({
  t,
  tone,
  from = 'right',
  children,
}: {
  t: number;
  tone: Tone;
  from?: 'right' | 'left' | 'bottom';
  children: ReactNode;
}) {
  const edge = (1 - progress(t, -overlap, 0.39)) * 100;
  const clip =
    from === 'bottom'
      ? `inset(${edge}% 0 0 0)`
      : from === 'left'
        ? `inset(0 ${edge}% 0 0)`
        : `polygon(${edge}% 0,100% 0,100% 100%,${Math.min(100, edge * 1.055)}% 100%)`;
  return (
    <AbsoluteFill
      className={`hc-surface hc-${tone}`}
      style={{ clipPath: clip }}
    >
      {children}
    </AbsoluteFill>
  );
}

function Proof({
  shot,
  crop: [x, y, width, height],
  at: [left, top],
  scale,
  enter = 1,
  tilt = 0,
  opacity = 1,
}: {
  shot: string;
  crop: Crop;
  at: [number, number];
  scale: number;
  enter?: number;
  tilt?: number;
  opacity?: number;
}) {
  return (
    <div
      className="hc-proof"
      style={{
        width,
        height,
        left: left + (1 - enter) * 52,
        top: top + (1 - enter) * 32,
        transform: `perspective(2000px) rotateY(${tilt + (1 - enter) * -7}deg) scale(${scale})`,
        opacity: enter * opacity,
      }}
    >
      <Img
        src={staticFile(`hiring-cut/${shot}.png`)}
        className="hc-capture"
        style={{ left: -x, top: -y }}
      />
    </div>
  );
}

function Copy({
  t,
  kicker,
  children,
  top = 135,
  left = 126,
  width = 1000,
  size = 104,
  start = 0.1,
}: {
  t: number;
  kicker: string;
  children: ReactNode;
  top?: number;
  left?: number;
  width?: number;
  size?: number;
  start?: number;
}) {
  return (
    <Headline
      label={kicker}
      progress={progress(t, start, start + 0.61)}
      className="hc-title"
      style={{ left, top, width, fontSize: size }}
    >
      {children}
    </Headline>
  );
}

function Small({
  x,
  y,
  t,
  children,
}: {
  x: number;
  y: number;
  t: number;
  children: ReactNode;
}) {
  return (
    <div
      className="hc-small"
      style={{ left: x, top: y, opacity: progress(t, 0.1, 0.68) }}
    >
      {children}
    </div>
  );
}

function Prepare() {
  const t = useLocalTime();
  const camera = progress(t, 0, 8);
  const issuing = t >= 3.5;
  const preview = t >= 1.95 && !issuing;
  const focus = progress(t, 4.3, 6.45);
  return (
    <Surface t={t} tone="paper">
      <Filament
        d="M -40 753 H 572 Q 700 753 796 681 L 1125 567"
        color="#438369"
        amount={progress(t, 0.2, 2.15)}
        opacity={0.58}
      />
      {issuing ? (
        <Proof
          shot="assign"
          crop={[465, 358, 922, 427]}
          at={[764 - focus * 53, 405 - focus * 98]}
          scale={1.095 + focus * 0.13}
          enter={progress(t, 3.48, 4.03)}
          tilt={-2}
        />
      ) : preview ? (
        <Proof
          shot="preview"
          crop={[465, 367, 919, 380]}
          at={[793, 387]}
          scale={1.125 + camera * 0.09}
          enter={progress(t, 1.95, 2.37)}
          tilt={-1.4}
        />
      ) : (
        <Proof
          shot="template"
          crop={[270, 111, 1110, 648]}
          at={[769 - camera * 50, 233 - camera * 28]}
          scale={0.965 + camera * 0.14}
          enter={progress(t, -0.32, 0.42)}
          tilt={-4 + camera * 3}
        />
      )}
      <Copy t={t} kicker="Assessment Builder" top={274} size={97} width={645}>
        Match the work
        <br />
        to the role.
      </Copy>
      <Small x={130} y={605} t={issuing ? t - 3.57 : t - 0.78}>
        {issuing ? (
          <>
            Assign an evaluator.
            <br />
            Issue the assessment.
          </>
        ) : (
          <>
            Choose a template or
            <br />
            reuse a team assessment.
          </>
        )}
      </Small>
    </Surface>
  );
}

function Candidate() {
  const t = useLocalTime();
  const stage =
    t < 2.55
      ? 'workspace'
      : t < 4.5
        ? 'workspace-edited'
        : 'workspace-submitted';
  const push = progress(t, 2.15, 3.27);
  const pull = progress(t, 4.05, 5.32);
  const zoom = push * (1 - pull);
  return (
    <Surface t={t} tone="plum" from="bottom">
      <Proof
        shot={stage}
        crop={[0, 0, 1440, 694]}
        at={[126 - 205 * zoom, 295 - 196 * zoom]}
        scale={1.158 + 0.325 * zoom}
        enter={progress(t, -0.08, 0.4)}
      />
      <AbsoluteFill style={{ opacity: 1 - progress(t, 1.83, 2.35) }}>
        <Copy
          t={t}
          kicker="Candidate workspace"
          top={96}
          size={61}
          width={1200}
        >
          A real repository to work in.
        </Copy>
        <Small x={130} y={223} t={t - 0.26}>
          Editor, terminal and AI controls
        </Small>
      </AbsoluteFill>
      <Filament
        d="M 2010 557 H 1764 Q 1530 557 1370 629 H 559"
        amount={progress(t, 2.37, 3.62)}
        opacity={0.72 * (1 - pull)}
      />
      {t >= 2.58 && t < 4.3 && (
        <Proof
          shot="workspace-tools"
          crop={[1029, 548, 381, 317]}
          at={[1325, 574]}
          scale={1.18}
          enter={progress(t, 2.58, 2.93)}
          opacity={1 - progress(t, 4.0, 4.3)}
        />
      )}
      {t >= 4.48 && (
        <div
          className="hc-receipt"
          style={{ opacity: progress(t, 4.48, 4.91) }}
        >
          Work submitted
        </div>
      )}
    </Surface>
  );
}

function Evidence() {
  const t = useLocalTime();
  const file = t >= 4.3;
  const detail = progress(t, 5.64, 6.59);
  const question = progress(t, 7.94, 8.52);
  return (
    <Surface t={t} tone="paper" from="left">
      <Copy t={t} kicker="Evidence review" size={106} width={1625}>
        See how the work changed.
      </Copy>
      <Small x={132} y={324} t={file ? t - 4.38 : t - 0.54}>
        {file
          ? 'Open the submitted diff and leave a note on the source.'
          : 'Open a saved revision from the timeline.'}
      </Small>
      {!file ? (
        <>
          <Proof
            shot="evidence-chronology"
            crop={[48, 369, 532, 341]}
            at={[126 + progress(t, 2.1, 4.1) * 58, 425]}
            scale={1.39}
            enter={progress(t, 0.23, 0.86)}
          />
          <Proof
            shot="evidence-chronology"
            crop={[590, 370, 793, 498]}
            at={[934 - progress(t, 2.6, 4.0) * 78, 429]}
            scale={1.12}
            enter={progress(t, 1.01, 1.65)}
          />
          <Filament
            d="M -64 631 H 145 Q 322 631 367 587 H 932"
            color="#40866a"
            amount={progress(t, 0.7, 2.9)}
            opacity={0.68}
          />
        </>
      ) : (
        <>
          <Proof
            shot="evidence-diff"
            crop={[594, 370, 792, 493]}
            at={[681 - detail * 210, 402 + detail * 11]}
            scale={1.18 + detail * 0.11}
            opacity={(1 - detail * 0.59) * (1 - question * 0.62)}
            enter={progress(t, 4.26, 4.76)}
          />
          <Proof
            shot="evidence-diff"
            crop={[611, 710, 758, 46]}
            at={[126, 578]}
            scale={2.12}
            enter={detail}
            opacity={1 - question * 0.52}
          />
          <Proof
            shot="evidence-note"
            crop={[608, 551, 767, 226]}
            at={[826, 726]}
            scale={1.21}
            enter={question}
          />
          <Filament
            d="M -25 674 H 660 Q 755 674 834 776 H 1032"
            color="#40866a"
            amount={progress(t, 7.2, 9.35)}
            opacity={0.76}
          />
        </>
      )}
    </Surface>
  );
}

function PeerReview() {
  const t = useLocalTime();
  const responded = t >= 8.5;
  const reply = t >= 4.5 && !responded;
  const slide = progress(t, 4.5, 5.02);
  const complete = progress(t, 8.5, 9.2);
  const line = progress(t, 1.35, 4.37);
  return (
    <Surface t={t} tone="lilac">
      <Copy t={t} kicker="Team peer review" top={127} size={108} width={1500}>
        Get a second opinion.
      </Copy>
      <Small x={132} y={307} t={t - 0.6}>
        Ask a teammate to review the same evidence.
      </Small>
      <div
        className="hc-peer-label"
        style={{ left: 136, top: 435, opacity: progress(t, 0.42, 1.03) }}
      >
        <span />
        Sam Rivera <i>Evaluator</i>
      </div>
      <div
        className="hc-peer-label"
        style={{ left: 1100, top: 435, opacity: progress(t, 1.35, 2.12) }}
      >
        <span />
        Jordan Lee <i>Teammate</i>
      </div>
      <Filament
        d="M 162 502 H 877 Q 921 502 961 477 H 1742"
        color="#46816b"
        amount={line}
        opacity={0.72}
      />
      <Proof
        shot={responded ? 'peer-completed' : 'peer-request'}
        crop={responded ? [198, 737, 711, 159] : [198, 490, 711, 261]}
        at={[126 + complete * 66, 541 - complete * 9]}
        scale={1.16 + complete * 0.2}
        opacity={reply ? 1 - slide * 0.56 : 1}
        enter={progress(t, 0.4, 1.0)}
      />
      {reply && (
        <Proof
          shot="peer-response"
          crop={[225, 196, 657, 395]}
          at={[985 - slide * 33, 515]}
          scale={1.235}
          enter={slide}
        />
      )}
      {responded && (
        <div
          className="hc-peer-payoff"
          style={{
            opacity: complete,
            transform: `translateY(${(1 - complete) * 36}px)`,
          }}
        >
          One thread.
          <br />
          <em>Both perspectives.</em>
        </div>
      )}
    </Surface>
  );
}

function HumanReview() {
  const t = useLocalTime();
  const human = t >= 2.65;
  const reframe = progress(t, 0.42, 5.25);
  return (
    <Surface t={t} tone="plum" from="bottom">
      <Copy t={t} kicker="Human-owned review" top={284} size={95} width={760}>
        AI advice.
        <br />
        Human review.
      </Copy>
      <Small x={131} y={575} t={human ? t - 2.8 : t - 0.6}>
        {human ? (
          <>
            The reviewer owns
            <br />
            the final review.
          </>
        ) : (
          <>
            Optional AI advisory.
            <br />
            Source evidence stays visible.
          </>
        )}
      </Small>
      {human ? (
        <>
          <Proof
            shot="human-packet"
            crop={[199, 310, 709, 66]}
            at={[752, 283]}
            scale={1.42}
            enter={progress(t, 2.64, 3.08)}
          />
          <Proof
            shot="human-packet"
            crop={[199, 517, 709, 285]}
            at={[752, 402]}
            scale={1.42}
            enter={progress(t, 2.91, 3.44)}
          />
          <Filament
            d="M 687 782 H 754 Q 789 782 830 758 H 996"
            amount={progress(t, 3.55, 4.6)}
            opacity={0.72}
          />
        </>
      ) : (
        <Proof
          shot="advisory"
          crop={[910, 347, 380, 426]}
          at={[928 - reframe * 23, 185]}
          scale={1.6}
          enter={progress(t, -0.05, 0.44)}
          tilt={-5 + reframe * 4}
        />
      )}
      {!human && (
        <div
          className="hc-disclosure"
          style={{ opacity: progress(t, 0.45, 0.89) }}
        >
          Offline evidence summary
        </div>
      )}
    </Surface>
  );
}

function Decision() {
  const t = useLocalTime();
  const portal = t >= 4.38;
  const reveal = progress(t, 4.38, 4.95);
  return (
    <Surface t={t} tone="paper" from="left">
      <Copy
        t={t}
        kicker="Decision and feedback"
        top={118}
        width={1510}
        size={103}
      >
        Publish the next step.
      </Copy>
      <Small x={131} y={309} t={portal ? t - 4.4 : t - 0.58}>
        {portal
          ? 'The candidate sees their next step and feedback.'
          : 'Share feedback with the candidate. Keep team notes private.'}
      </Small>
      <Proof
        shot="decision"
        crop={[198, 245, 710, 617]}
        at={[126, 408]}
        scale={1.22}
        enter={progress(t, 0.03, 0.61)}
        opacity={1 - reveal * 0.74}
      />
      {!portal && (
        <Proof
          shot="decision-published"
          crop={[196, 465, 712, 66]}
          at={[1068, 641]}
          scale={1.07}
          enter={progress(t, 2.26, 2.95)}
        />
      )}
      {portal && (
        <>
          <Proof
            shot="portal-feedback"
            crop={[451, 329, 813, 301]}
            at={[580 - reveal * 55, 483]}
            scale={1.47}
            enter={reveal}
          />
          <Filament
            d="M -30 735 H 326 Q 409 735 521 696 H 657"
            color="#40866a"
            amount={progress(t, 4.46, 5.64)}
            opacity={0.62}
          />
        </>
      )}
    </Surface>
  );
}

function Handoff() {
  const t = useLocalTime();
  const focus = progress(t, 2.5, 4.35);
  return (
    <Surface t={t} tone="mint">
      <Copy t={t} kicker="Interview handoff" top={123} size={103} width={1615}>
        Carry the context forward.
      </Copy>
      <Small x={130} y={320} t={t - 0.62}>
        Give the next interviewer the evidence, notes and next-stage brief.
      </Small>
      <Proof
        shot="handoff"
        crop={[274, 285, 1110, 550]}
        at={[126 + focus * 21, 413 - focus * 12]}
        scale={1.48 + focus * 0.024}
        enter={progress(t, 0, 0.73)}
        opacity={1 - focus * 0.72}
        tilt={-2 + focus * 2}
      />
      <Proof
        shot="handoff-feedback"
        crop={[557, 459, 832, 344]}
        at={[569 - focus * 83, 501 - focus * 24]}
        scale={1.5}
        enter={focus}
      />
      <Proof
        shot="handoff"
        crop={[1115, 182, 274, 51]}
        at={[145, 871]}
        scale={1.58}
        enter={progress(t, 5.3, 5.94)}
      />
      <Filament
        d="M -28 624 H 263 Q 341 624 430 568 H 550"
        color="#40866a"
        amount={progress(t, 2.6, 4.7)}
        opacity={0.73}
      />
    </Surface>
  );
}

export function HiringCut() {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill className="fl-film">
      <Sequence
        name="Follow the Work"
        from={0}
        durationInFrames={Math.round(4.42 * fps)}
      >
        <Opening />
      </Sequence>
      <Sequence
        name="Prepare and assign"
        from={Math.round((4 - overlap) * fps)}
        durationInFrames={Math.round(8.84 * fps)}
        premountFor={fps}
      >
        <Prepare />
      </Sequence>
      <Sequence
        name="Candidate workspace"
        from={Math.round((12 - overlap) * fps)}
        durationInFrames={Math.round(6.84 * fps)}
        premountFor={fps}
      >
        <Candidate />
      </Sequence>
      <Sequence
        name="Saved work and source evidence"
        from={Math.round((18 - overlap) * fps)}
        durationInFrames={Math.round(10.84 * fps)}
        premountFor={fps}
      >
        <Evidence />
      </Sequence>
      <Sequence
        name="Ask and receive peer review"
        from={Math.round((28 - overlap) * fps)}
        durationInFrames={Math.round(14.84 * fps)}
        premountFor={fps}
      >
        <PeerReview />
      </Sequence>
      <Sequence
        name="Advisory evidence and human packet"
        from={Math.round((42 - overlap) * fps)}
        durationInFrames={Math.round(6.84 * fps)}
        premountFor={fps}
      >
        <HumanReview />
      </Sequence>
      <Sequence
        name="Publish decision and feedback"
        from={Math.round((48 - overlap) * fps)}
        durationInFrames={Math.round(8.84 * fps)}
        premountFor={fps}
      >
        <Decision />
      </Sequence>
      <Sequence
        name="Next interviewer handoff"
        from={Math.round((56 - overlap) * fps)}
        durationInFrames={Math.round(8.84 * fps)}
        premountFor={fps}
      >
        <Handoff />
      </Sequence>
      <Sequence
        name="Hirearchy Software"
        from={Math.round(63.7 * fps)}
        premountFor={fps}
      >
        <Closing />
      </Sequence>
      <Audio
        name="Common Thread beat and Foley"
        src={staticFile('hiring-cut/common-thread-beat.wav')}
        premountFor={fps}
      />
    </AbsoluteFill>
  );
}
