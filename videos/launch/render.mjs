import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('.', import.meta.url));
const output = fileURLToPath(new URL('../../launch-renders/', import.meta.url));
const args = process.argv.slice(2);
const ad = args[0] === '--ad';
const ratio = args[ad ? 1 : 0];
const ratios = ratio ? [ratio] : ['16x9', '9x16'];
const browser = process.env.HIREARCHY_RENDER_CHROME;
mkdirSync(output, { recursive: true });

function run(program, command) {
  const result = spawnSync(program, command, {
    cwd: project,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${program} did not complete (status ${result.status}, signal ${result.signal})`,
    );
}

const ffmpegEncoders = ad
  ? spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
  : null;
if (ffmpegEncoders?.error) throw ffmpegEncoders.error;
const aac = ffmpegEncoders?.stdout?.includes('libfdk_aac')
  ? 'libfdk_aac'
  : 'aac';

for (const format of ratios) {
  if (format !== '16x9' && format !== '9x16')
    throw new Error('Expected 16x9 or 9x16');
  const name = ad ? 'Ad' : 'Launch';
  const target = join(output, `Hirearchy_${name}_${format}.mp4`);
  const scratch = ad ? mkdtempSync(join(output, '.ad-')) : null;
  const picture = scratch ? join(scratch, 'picture.mp4') : target;

  try {
    run('remotion', [
      'render',
      'src/index.tsx',
      `Hirearchy${name}${format}`,
      picture,
      '--image-format=jpeg',
      '--jpeg-quality=95',
      '--crf=16',
      '--x264-preset=veryfast',
      '--color-space=bt709',
      '--pixel-format=yuv420p',
      `--concurrency=${process.env.HIREARCHY_RENDER_CONCURRENCY ?? 2}`,
      ...(ad ? ['--muted'] : ['--audio-bitrate=320k']),
      ...(browser ? [`--browser-executable=${browser}`] : []),
    ]);
    if (scratch) {
      const muxed = join(scratch, 'master.mp4');
      run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-i',
        picture,
        '-i',
        join(project, 'public', 'lead-gen-master.wav'),
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        aac,
        '-profile:a',
        'aac_low',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        muxed,
      ]);
      renameSync(muxed, target);
      console.log(target);
    }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
