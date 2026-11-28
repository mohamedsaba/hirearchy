import type { ComponentType } from 'react';
import { Audio } from '@remotion/media';
import {
  AbsoluteFill,
  Composition,
  Folder,
  Series,
  registerRoot,
  staticFile,
  useVideoConfig,
} from 'remotion';
import { z } from 'zod';
import { Act1Tension } from './Act1Tension';
import { Act2Builder } from './Act2Builder';
import { Act3Workspace } from './Act3Workspace';
import { Act4ChronologyFollowup } from './Act4ChronologyFollowup';
import { Act5Finale } from './Act5Finale';
import './film.css';
import { LeadGen } from './LeadGen';
import { FirstLook, firstLookSeconds } from './FirstLook';
import { HiringCut, hiringCutSeconds } from './HiringCut';

const fps = 60;
const audioSchema = z.object({ voiceover: z.boolean() });
type FilmProps = z.infer<typeof audioSchema>;

function LaunchFilm({ voiceover }: FilmProps) {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Series>
        <Series.Sequence
          name="The tension"
          durationInFrames={8 * fps}
          premountFor={fps}
        >
          <Act1Tension />
        </Series.Sequence>
        <Series.Sequence
          name="The shift"
          durationInFrames={7 * fps}
          premountFor={fps}
        >
          <Act2Builder />
        </Series.Sequence>
        <Series.Sequence
          name="The workspace"
          durationInFrames={9 * fps}
          premountFor={fps}
        >
          <Act3Workspace />
        </Series.Sequence>
        <Series.Sequence
          name="Chronology and follow-up"
          durationInFrames={12 * fps}
          premountFor={fps}
        >
          <Act4ChronologyFollowup />
        </Series.Sequence>
        <Series.Sequence
          name="The finale"
          durationInFrames={9 * fps}
          premountFor={fps}
        >
          <Act5Finale />
        </Series.Sequence>
      </Series>
      <Audio
        name="Score and Foley"
        src={staticFile('score-and-foley.wav')}
        premountFor={fps}
      />
      {voiceover && (
        <Audio
          name="Narration"
          src={staticFile('narration.wav')}
          premountFor={fps}
        />
      )}
    </AbsoluteFill>
  );
}

function scene(id: string, seconds: number, component: ComponentType) {
  return (
    <Composition
      id={id}
      durationInFrames={seconds * fps}
      fps={fps}
      width={1920}
      height={1080}
      component={component}
    />
  );
}

function Root() {
  return (
    <>
      <Composition
        id="HirearchyHiringCut"
        component={HiringCut}
        durationInFrames={hiringCutSeconds * 30}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="HirearchyFirstLook"
        component={FirstLook}
        durationInFrames={Math.round(firstLookSeconds * 30)}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="HirearchyLaunch16x9"
        component={LaunchFilm}
        durationInFrames={2700}
        fps={60}
        width={1920}
        height={1080}
        schema={audioSchema}
        defaultProps={{ voiceover: true }}
      />
      <Composition
        id="HirearchyLaunch9x16"
        component={LaunchFilm}
        durationInFrames={2700}
        fps={60}
        width={1080}
        height={1920}
        schema={audioSchema}
        defaultProps={{ voiceover: true }}
      />
      <Composition
        id="HirearchyAd16x9"
        component={LeadGen}
        durationInFrames={2100}
        fps={60}
        width={1920}
        height={1080}
      />
      <Composition
        id="HirearchyAd9x16"
        component={LeadGen}
        durationInFrames={2100}
        fps={60}
        width={1080}
        height={1920}
      />
      <Folder name="Acts">
        {scene('Act1Tension', 8, Act1Tension)}
        {scene('Act2Builder', 7, Act2Builder)}
        {scene('Act3Workspace', 9, Act3Workspace)}
        {scene('Act4ChronologyFollowup', 12, Act4ChronologyFollowup)}
        {scene('Act5Finale', 9, Act5Finale)}
      </Folder>
    </>
  );
}

registerRoot(Root);
