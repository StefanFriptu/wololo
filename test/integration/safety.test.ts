import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type FakeUpstream, startFakeUpstream } from '../../src/modules/integrations/fake-upstream.ts';
import type { MediaFileSummary, Paginated, QueueResponse } from '../../src/shared/api-types.ts';
import type { JobDetail, JobSummary, RecycleBinEntry } from '../../src/shared/domain.ts';
import { ensureFixtureCopy, type FixtureSpec, ffmpegAvailable } from '../helpers/fixtures.ts';
import {
  type ApiCall,
  apiClient,
  type ChildServer,
  eventually,
  ffprobeJson,
  startChildServer,
} from '../helpers/server.ts';

const API_KEY = 'safety-test-api-key-0123456789';
const DTS_20S: FixtureSpec = {
  name: 'integration-dts-20s',
  durationSec: 20,
  audio: [{ codec: 'dts', layout: '5.1', language: 'eng' }],
};
const DTS_3S: FixtureSpec = { name: 'integration-dts-3s', audio: [{ codec: 'dts', layout: '5.1', language: 'eng' }] };

type FfmpegMode = 'normal' | 'slow' | 'truncate';
interface SseFrame {
  name: string;
  data: Record<string, unknown>;
}

let dir: string;
let movies: string;
let configDir: string;
let modeFile: string;
let wrapper: string;
let child: ChildServer | null = null;
let plex: FakeUpstream;
let plexSessions = 0;
let movieLibraryId: number;
const call: ApiCall = apiClient(
  () => child?.base ?? 'http://127.0.0.1:0',
  () => API_KEY,
);

/** Real ffmpeg behind a switch: "slow" reads the input in real time, "truncate" cuts the job output to one second. */
function writeFfmpegWrapper(path: string): void {
  const ffmpeg = Bun.which('ffmpeg');
  writeFileSync(
    path,
    [
      '#!/bin/bash',
      `mode=$(cat '${modeFile}')`,
      'for last; do :; done',
      'if [[ "$last" == *wololo-tmp* ]]; then',
      `  [[ "$mode" == slow ]] && exec '${ffmpeg}' -readrate 1 "$@"`,
      `  [[ "$mode" == truncate ]] && exec '${ffmpeg}' "\${@:1:$#-1}" -t 1 "$last"`,
      'fi',
      `exec '${ffmpeg}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

function ffmpegMode(mode: FfmpegMode): void {
  writeFileSync(modeFile, mode);
}

async function boot(): Promise<void> {
  child = await startChildServer(configDir, { WOLOLO__API_KEY: API_KEY, WOLOLO__FFMPEG: wrapper });
}

async function md5(path: string): Promise<string> {
  return new Bun.CryptoHasher('md5').update(await Bun.file(path).arrayBuffer()).digest('hex');
}

function tempFiles(path: string): string[] {
  return readdirSync(dirname(path)).filter((name) => name.includes('.wololo-tmp'));
}

async function newMovie(spec: FixtureSpec, title: string): Promise<string> {
  return ensureFixtureCopy(spec, join(movies, title), `${title}.mkv`);
}

async function scanAndFindJob(path: string): Promise<JobSummary> {
  await call('/api/v1/scans', { method: 'POST', json: { libraryId: movieLibraryId } });
  const row = await eventually(
    `media row for ${path}`,
    async () => (await call<Paginated<MediaFileSummary>>('/api/v1/media?pageSize=500')).items,
    (items) => items.some((item) => item.path === path),
  );
  const media = row.find((item) => item.path === path) as MediaFileSummary;
  const jobs = await eventually(
    `job for ${path}`,
    () => call<Paginated<JobSummary>>(`/api/v1/jobs?mediaFileId=${media.id}`),
    (page) => page.total > 0,
  );
  return jobs.items[0] as JobSummary;
}

function job(id: number): Promise<JobDetail> {
  return call<JobDetail>(`/api/v1/jobs/${id}`);
}

function untilState(id: number, states: string[], timeoutMs = 60_000): Promise<JobDetail> {
  return eventually(
    `job ${id} in ${states.join('|')}`,
    () => job(id),
    (detail) => states.includes(detail.state),
    timeoutMs,
  );
}

function untilEncoding(id: number): Promise<JobDetail> {
  return eventually(
    `job ${id} encoding`,
    () => job(id),
    (detail) => detail.state === 'running' && detail.step === 'encoding' && detail.progress > 0,
  );
}

function queueReasons(): Promise<string[]> {
  return call<QueueResponse>('/api/v1/queue').then((queue) => queue.state.pauseReasons);
}

async function audioCodecs(path: string): Promise<string[]> {
  const probe = await ffprobeJson<{ streams: { codec_type: string; codec_name: string }[] }>(path);
  return probe.streams.filter((stream) => stream.codec_type === 'audio').map((stream) => stream.codec_name);
}

function collectEvents(base: string): { frames: SseFrame[]; close(): void } {
  const frames: SseFrame[] = [];
  const controller = new AbortController();
  void (async () => {
    const response = await fetch(`${base}/api/v1/events?apikey=${API_KEY}`, { signal: controller.signal });
    if (!response.body) return;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (name) frames.push({ name, data: data ? JSON.parse(data) : {} });
      }
    }
  })().catch(() => undefined);
  return { frames, close: () => controller.abort() };
}

describe.skipIf(!ffmpegAvailable() || process.platform === 'win32')(
  'real process: crash, verification and gates',
  () => {
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'wololo-safety-'));
      movies = join(dir, 'media', 'movies');
      configDir = join(dir, 'config');
      modeFile = join(dir, 'ffmpeg-mode');
      wrapper = join(dir, 'ffmpeg-wrapper.sh');
      ffmpegMode('normal');
      writeFfmpegWrapper(wrapper);
      plex = startFakeUpstream({
        'GET /library/sections': () => ({ MediaContainer: { Directory: [] } }),
        'GET /status/sessions': () => ({
          MediaContainer: { size: plexSessions, Metadata: plexSessions ? [{ title: 'Heat', type: 'movie' }] : [] },
        }),
      });
      await boot();
      await call('/api/v1/settings', { method: 'PUT', json: { processing: { enabled: true } } });
      movieLibraryId = (
        await call<{ id: number }>('/api/v1/libraries', {
          method: 'POST',
          json: { name: 'Movies', kind: 'movies', roots: [movies], profileIds: [] },
        })
      ).id;
      await call('/api/v1/plex', { method: 'PUT', json: { serverUrl: plex.url, serverToken: 'token', enabled: true } });
    });

    afterAll(async () => {
      await child?.kill('SIGTERM');
      plex?.stop();
      rmSync(dir, { recursive: true, force: true });
    });

    test('step 1 - kill -9 mid-encode keeps the original; the restart drops the temp file and finishes the job', async () => {
      ffmpegMode('slow');
      const path = await newMovie(DTS_20S, 'Crash (2010)');
      const original = await md5(path);
      const queued = await scanAndFindJob(path);
      await untilEncoding(queued.id);
      expect(tempFiles(path)).toEqual([`Crash (2010).wololo-tmp-${queued.id}.mkv`]);

      await child?.kill('SIGKILL');
      Bun.spawnSync(['pkill', '-9', '-f', 'Crash \\(2010\\)\\.wololo-tmp']);
      expect(await md5(path)).toBe(original);
      expect(tempFiles(path)).toHaveLength(1);

      ffmpegMode('normal');
      await boot();
      const done = await untilState(queued.id, ['completed', 'failed']);
      expect(done).toMatchObject({ state: 'completed', error: null });
      expect(await audioCodecs(path)).toEqual(['ac3']);
      expect(tempFiles(path)).toEqual([]);
      const bin = await call<Paginated<RecycleBinEntry>>('/api/v1/recyclebin');
      const entry = bin.items.find((item) => item.originalPath === path);
      expect(entry && (await md5(entry.recyclePath))).toBe(original);
    });

    test('step 2 - a failed verification leaves the original untouched and fails the job with a log', async () => {
      ffmpegMode('truncate');
      const path = await newMovie(DTS_3S, 'Broken (2011)');
      const original = await md5(path);
      const queued = await scanAndFindJob(path);
      const failed = await untilState(queued.id, ['completed', 'failed']);
      ffmpegMode('normal');

      expect(failed.state).toBe('failed');
      expect(failed.error).toStartWith('verification failed: duration');
      expect(failed.verification?.checks.find((check) => check.name === 'duration')?.passed).toBe(false);
      expect(await md5(path)).toBe(original);
      expect(tempFiles(path)).toEqual([]);
      const bin = await call<Paginated<RecycleBinEntry>>('/api/v1/recyclebin');
      expect(bin.total).toBeGreaterThan(0);
      expect(bin.items.some((item) => item.originalPath === path)).toBe(false);
      const log = await (
        await fetch(`${child?.base}/api/v1/jobs/${queued.id}/log`, { headers: { 'x-api-key': API_KEY } })
      ).text();
      expect(log).toContain('verify duration: FAILED');
      expect(log).toContain('==== failed: verification failed');
    });

    test('step 3 - cancelling a running job removes its temp file; retry runs it again to completion', async () => {
      ffmpegMode('slow');
      const path = await newMovie(DTS_20S, 'Cancel (2012)');
      const original = await md5(path);
      const queued = await scanAndFindJob(path);
      await untilEncoding(queued.id);
      expect(tempFiles(path)).toHaveLength(1);

      await call(`/api/v1/jobs/${queued.id}/cancel`, { method: 'POST' });
      await untilState(queued.id, ['cancelled']);
      expect(tempFiles(path)).toEqual([]);
      expect(await md5(path)).toBe(original);

      ffmpegMode('normal');
      await call(`/api/v1/jobs/${queued.id}/retry`, { method: 'POST' });
      expect(await untilState(queued.id, ['completed', 'failed'])).toMatchObject({ state: 'completed', attempts: 1 });
    });

    test('step 4 - user pause, processing window and Plex streaming hold the queue; progress streams over SSE', async () => {
      const events = collectEvents(child?.base as string);
      await eventually(
        'SSE hello',
        async () => events.frames.length,
        (count) => count > 0,
      );
      await call('/api/v1/queue/pause', { method: 'POST' });
      ffmpegMode('slow');
      const path = await newMovie(DTS_20S, 'Gate (2013)');
      const queued = await scanAndFindJob(path);
      await Bun.sleep(500);
      expect((await job(queued.id)).state).toBe('queued');
      expect(await queueReasons()).toEqual(['user']);

      await call('/api/v1/queue/resume', { method: 'POST' });
      await untilEncoding(queued.id);

      const hour = new Date().getHours();
      const start = `${String((hour + 2) % 24).padStart(2, '0')}:00`;
      const end = `${String((hour + 3) % 24).padStart(2, '0')}:00`;
      await call('/api/v1/settings', {
        method: 'PUT',
        json: { processing: { window: { enabled: true, start, end } } },
      });
      await untilState(queued.id, ['queued'], 20_000);
      expect(await queueReasons()).toEqual(['window']);
      expect(tempFiles(path)).toEqual([]);
      await call('/api/v1/settings', { method: 'PUT', json: { processing: { window: { enabled: false } } } });
      await untilEncoding(queued.id);

      plexSessions = 1;
      await call('/api/v1/plex', { method: 'PUT', json: { pauseWhileStreaming: true } });
      await untilState(queued.id, ['queued'], 20_000);
      expect(await queueReasons()).toEqual(['plex_streaming']);
      ffmpegMode('normal');
      await call('/api/v1/plex', { method: 'PUT', json: { pauseWhileStreaming: false } });
      const done = await untilState(queued.id, ['completed', 'failed']);
      events.close();

      expect(done).toMatchObject({ state: 'completed', attempts: 1 });
      expect(events.frames[0]?.name).toBe('hello');
      const progress = events.frames.filter((frame) => frame.name === 'job.progress' && frame.data.jobId === queued.id);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress[0]?.data).toMatchObject({ step: 'encoding' });
      expect(progress.some((frame) => Number(frame.data.speed) > 0 && frame.data.etaSec != null)).toBe(true);
      const pauses = events.frames
        .filter((frame) => frame.name === 'queue.state')
        .flatMap((frame) => frame.data.pauseReasons as string[]);
      expect(new Set(pauses)).toEqual(new Set(['user', 'window', 'plex_streaming']));
      expect(events.frames.some((frame) => frame.name === 'log.entry')).toBe(false);
    });
  },
);
