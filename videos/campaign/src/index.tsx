import { Composition, Still, registerRoot } from 'remotion';
import { FPS } from './tokens';
import { HERO_MASTER_SECONDS, HeroMaster16x9 } from './films/HeroMaster16x9';
import { SOCIAL_REEL_SECONDS, SocialReel9x16 } from './films/SocialReel9x16';
import {
  THESIS_TEASER_SECONDS,
  ThesisTeaser16x9,
} from './films/ThesisTeaser16x9';
import {
  Still01Manifesto,
  Still02Two100s,
  Still03AuthenticIde,
  Still04AiAndHuman,
  Still05Horizon,
} from './stills/EditorialStills';

function CampaignRoot() {
  return (
    <>
      {/* 3 LAUNCH CAMPAIGN FILMS (60 fps) */}
      <Composition
        id="HirearchyLaunchMaster16x9"
        component={HeroMaster16x9}
        durationInFrames={HERO_MASTER_SECONDS * FPS}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="HirearchySocialReel9x16"
        component={SocialReel9x16}
        durationInFrames={SOCIAL_REEL_SECONDS * FPS}
        fps={FPS}
        width={1080}
        height={1920}
      />
      <Composition
        id="HirearchyThesisTeaser16x9"
        component={ThesisTeaser16x9}
        durationInFrames={THESIS_TEASER_SECONDS * FPS}
        fps={FPS}
        width={1920}
        height={1080}
      />

      {/* 5 GALLERY-GRADE EDITORIAL STILLS / SOCIAL POSTERS */}
      <Still
        id="Still01Manifesto"
        component={Still01Manifesto}
        width={2400}
        height={1350}
      />
      <Still
        id="Still02Two100s"
        component={Still02Two100s}
        width={1600}
        height={2000}
      />
      <Still
        id="Still03AuthenticIde"
        component={Still03AuthenticIde}
        width={1600}
        height={2000}
      />
      <Still
        id="Still04AiAndHuman"
        component={Still04AiAndHuman}
        width={1600}
        height={2000}
      />
      <Still
        id="Still05Horizon"
        component={Still05Horizon}
        width={2400}
        height={1350}
      />
    </>
  );
}

registerRoot(CampaignRoot);
