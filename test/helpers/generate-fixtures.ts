import { ensureFixture, FIXTURES, ffmpegAvailable } from './fixtures.ts';

if (!ffmpegAvailable()) {
  console.error('ffmpeg/ffprobe not found on PATH');
  process.exit(1);
}

for (const spec of Object.values(FIXTURES)) {
  const started = performance.now();
  const path = await ensureFixture(spec);
  console.log(`${spec.name.padEnd(16)} ${Math.round(performance.now() - started)} ms  ${path}`);
}
