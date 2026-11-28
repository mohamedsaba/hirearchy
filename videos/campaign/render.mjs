import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('.', import.meta.url));
const outDir = fileURLToPath(
  new URL('../../launch-renders/campaign/', import.meta.url),
);
const stillsDir = join(outDir, 'stills');
mkdirSync(stillsDir, { recursive: true });

const remotionBin = join(project, 'node_modules/.bin/remotion');
const concurrency = process.env.HIREARCHY_RENDER_CONCURRENCY ?? '4';
const only = process.argv[2] ?? 'all';

function run(cmd, args) {
  console.log(`\n>>> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: project, stdio: 'inherit' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`Command failed with status ${res.status}`);
  }
}

const stills = [
  ['Still01Manifesto', '01_Manifesto_Hero_16x9.png'],
  ['Still02Two100s', '02_Two_100s_Contrast_4x5.png'],
  ['Still03AuthenticIde', '03_Authentic_IDE_Zero_Spyware_4x5.png'],
  ['Still04AiAndHuman', '04_AI_Synthesizes_People_Decide_4x5.png'],
  ['Still05Horizon', '05_Common_Thread_Horizon_16x9.png'],
];

const films = [
  ['HirearchyThesisTeaser16x9', '03_Hirearchy_Thesis_Teaser_16x9.mp4'],
  ['HirearchySocialReel9x16', '02_Hirearchy_Social_Reel_9x16.mp4'],
  ['HirearchyLaunchMaster16x9', '01_Hirearchy_Launch_Master_16x9.mp4'],
];

if (only === 'all' || only === 'stills') {
  for (const [id, filename] of stills) {
    run(remotionBin, [
      'still',
      'src/index.tsx',
      id,
      join(stillsDir, filename),
      '--image-format=png',
    ]);
  }
}

if (
  only === 'all' ||
  only === 'films' ||
  only === 'teaser' ||
  only === 'reel' ||
  only === 'master'
) {
  for (const [id, filename] of films) {
    if (only === 'teaser' && !id.includes('Teaser')) continue;
    if (only === 'reel' && !id.includes('Reel')) continue;
    if (only === 'master' && !id.includes('Master')) continue;
    run(remotionBin, [
      'render',
      'src/index.tsx',
      id,
      join(outDir, filename),
      '--image-format=jpeg',
      '--jpeg-quality=96',
      '--crf=15',
      '--x264-preset=medium',
      '--color-space=bt709',
      '--pixel-format=yuv420p',
      '--audio-bitrate=320k',
      `--concurrency=${concurrency}`,
    ]);
  }
}

console.log('\n[CAMPAIGN EXPORT COMPLETE]', outDir);
