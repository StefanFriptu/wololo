import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type Runtime } from '../../src/app/bootstrap.ts';
import type {
  DryRunReport,
  EnqueueResponse,
  MediaFileDetail,
  MediaFileSummary,
  Paginated,
  ProfileWithUsage,
  QueueResponse,
} from '../../src/shared/api-types.ts';
import type { HistoryEntry, JobSummary, Library, RecycleBinEntry } from '../../src/shared/domain.ts';
import { ensureFixtureCopy, FIXTURES, type FixtureSpec, ffmpegAvailable } from '../helpers/fixtures.ts';

const EAC3_MP4: FixtureSpec = {
  name: 'eac3-stereo-mp4',
  audio: [{ codec: 'eac3', layout: 'stereo', language: 'eng' }],
  container: 'mp4',
};

let dir: string;
let runtime: Runtime;
let base: string;
let apiKey: string;
let movies: string;
let strict: string;
let dtsPath: string;
let mp4Path: string;

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}, status = 200): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-api-key', apiKey);
  const body = init.json === undefined ? init.body : JSON.stringify(init.json);
  const response = await fetch(`${base}${path}`, { ...init, body, headers });
  if (response.status !== status)
    throw new Error(
      `${init.method ?? 'GET'} ${path}: expected ${status}, got ${response.status}: ${await response.text()}`,
    );
  return (status === 204 ? undefined : await response.json()) as T;
}

async function eventually<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const started = Date.now();
  let attempts = 0;
  let last: T;
  do {
    attempts += 1;
    last = await read();
    if (done(last)) return last;
    await Bun.sleep(100);
  } while (Date.now() - started < 60_000);
  throw new Error(
    `${what}: not reached after ${attempts} attempts in ${Date.now() - started} ms: ${JSON.stringify(last)}`,
  );
}

async function mediaAt(path: string): Promise<MediaFileSummary> {
  const page = await call<Paginated<MediaFileSummary>>(`/api/v1/media?search=${encodeURIComponent(path)}`);
  const found = page.items.find((item) => item.path === path);
  if (!found) throw new Error(`no media row for ${path}: ${JSON.stringify(page.items.map((item) => item.path))}`);
  return found;
}

async function scan(): Promise<void> {
  await call('/api/v1/scans', { method: 'POST', json: {} });
  await eventually(
    'scan finished',
    () => call<{ running: boolean } | null>('/api/v1/scans/current'),
    (scan) => !scan?.running,
  );
}

async function ffprobeAudio(path: string): Promise<{ codec_name: string; channels: number; bit_rate?: string }[]> {
  const proc = Bun.spawn(['ffprobe', '-v', 'error', '-select_streams', 'a', '-show_streams', '-of', 'json', path]);
  return JSON.parse(await new Response(proc.stdout).text()).streams;
}

describe.skipIf(!ffmpegAvailable())('real services: dry run -> processing -> recycle bin', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wololo-pipeline-'));
    movies = join(dir, 'media', 'movies');
    strict = join(dir, 'media', 'strict');
    dtsPath = await ensureFixtureCopy(FIXTURES.dts51, join(movies, 'Dts Movie (2020)'), 'Dts Movie (2020).mkv');
    mp4Path = await ensureFixtureCopy(EAC3_MP4, join(movies, 'Mp4 Movie (2021)'), 'Mp4 Movie (2021).mp4');
    writeFileSync(join(movies, 'Dts Movie (2020)', 'Leftover.wololo-tmp.mkv'), 'partial');
    mkdirSync(join(movies, '.wololo-recycle'), { recursive: true });
    writeFileSync(join(movies, '.wololo-recycle', 'Old.mkv'), 'recycled');
    await ensureFixtureCopy(FIXTURES.ac3Compatible, strict, 'Strict.mkv');

    runtime = createRuntime({
      env: { WOLOLO_WEB_DIR: join(dir, 'no-web') },
      configDir: join(dir, 'config'),
      port: 0,
      console: false,
    });
    const server = await runtime.start();
    base = `http://127.0.0.1:${server.port}`;
    apiKey = runtime.ctx.config.get().apiKey;
  });

  afterAll(async () => {
    await runtime?.stop('test');
    rmSync(dir, { recursive: true, force: true });
  });

  test('step 1 - startup seeded the Samsung Tizen profile and every scheduled task, the queue reports dry run', async () => {
    const profiles = await call<ProfileWithUsage[]>('/api/v1/profiles');
    expect(profiles.map((profile) => profile.name)).toEqual(['Samsung Tizen']);
    expect((await call<{ name: string }[]>('/api/v1/system/tasks')).map((task) => task.name).sort()).toEqual([
      'backup',
      'housekeeping',
      'library_scan',
      'log_cleanup',
      'recycle_bin_purge',
      'seeding_check',
    ]);
    expect((await call<QueueResponse>('/api/v1/queue')).state.pauseReasons).toEqual(['dry_run']);
  });

  test('step 2 - a dry-run scan indexes media but never temp files or the recycle bin, and blocks unplayable video', async () => {
    const tizen = (await call<ProfileWithUsage[]>('/api/v1/profiles'))[0] as ProfileWithUsage;
    const hevcOnly = await call<ProfileWithUsage>('/api/v1/profiles', {
      method: 'POST',
      json: {
        name: 'HEVC only',
        definition: { ...tizen.definition, video: { ...tizen.definition.video, allowedCodecs: ['hevc'] } },
      },
    });
    await call<Library>('/api/v1/libraries', {
      method: 'POST',
      json: { name: 'Movies', kind: 'movies', roots: [movies], profileIds: [] },
    });
    await call<Library>('/api/v1/libraries', {
      method: 'POST',
      json: { name: 'Strict', kind: 'movies', roots: [strict], profileIds: [hevcOnly.id] },
    });
    await scan();

    const all = await call<Paginated<MediaFileSummary>>('/api/v1/media?pageSize=500');
    expect(all.items.map((item) => item.relativePath).sort()).toEqual([
      'Dts Movie (2020)/Dts Movie (2020).mkv',
      'Mp4 Movie (2021)/Mp4 Movie (2021).mp4',
      'Strict.mkv',
    ]);
    expect((await mediaAt(dtsPath)).status).toBe('needs_work');
    expect((await mediaAt(mp4Path)).status).toBe('needs_work');
    const blocked = await mediaAt(join(strict, 'Strict.mkv'));
    expect(blocked).toMatchObject({ status: 'blocked', planAction: 'blocked' });
    expect(blocked.statusReason).toStartWith('blocked: ');
    const report = await call<DryRunReport>('/api/v1/dryrun');
    expect(report.totals).toMatchObject({ files: 3, needsWork: 2, blocked: 1, failed: 0 });
  });

  test('step 3 - with processing on, "process all needs-work" converts both files and skips the blocked one', async () => {
    await call('/api/v1/settings', { method: 'PUT', json: { processing: { enabled: true } } });
    const queued = await call<EnqueueResponse>('/api/v1/jobs', {
      method: 'POST',
      json: { filter: { status: 'needs_work' } },
    });
    expect(queued.jobs).toHaveLength(2);
    const forced = await call<EnqueueResponse>('/api/v1/jobs', {
      method: 'POST',
      json: { mediaFileIds: [(await mediaAt(join(strict, 'Strict.mkv'))).id] },
    });
    expect(forced).toEqual({ jobs: [], skipped: [expect.objectContaining({ reason: 'status is blocked' })] });

    const finished = await eventually(
      'jobs finished',
      () => call<Paginated<JobSummary>>('/api/v1/jobs?state=completed,failed,cancelled'),
      (page) => page.total === 2,
    );
    expect(finished.items.map((job) => [job.state, job.error])).toEqual([
      ['completed', null],
      ['completed', null],
    ]);
  });

  test('step 4 - the DTS track became one AC3 5.1 640 kbps track in place', async () => {
    const audio = await ffprobeAudio(dtsPath);
    expect(audio.map((stream) => [stream.codec_name, stream.channels, stream.bit_rate])).toEqual([
      ['ac3', 6, '640000'],
    ]);
    const row = await mediaAt(dtsPath);
    expect(row).toMatchObject({ status: 'compatible', audioCodecs: ['ac3'] });
    expect(existsSync(join(movies, 'Dts Movie (2020)', 'Leftover.wololo-tmp.mkv'))).toBe(true);
  });

  test('step 5 - the mp4 became an mkv: the media row follows the new path, the original sits in the recycle bin', async () => {
    const mkvPath = mp4Path.replace(/\.mp4$/, '.mkv');
    expect(existsSync(mp4Path)).toBe(false);
    expect((await ffprobeAudio(mkvPath)).map((stream) => stream.codec_name)).toEqual(['ac3']);
    const row = await mediaAt(mkvPath);
    expect(row.status).toBe('compatible');
    const detail = await call<MediaFileDetail>(`/api/v1/media/${row.id}`);
    expect(detail.jobs[0]).toMatchObject({ state: 'completed', outputPath: mkvPath });
    const bin = await call<Paginated<RecycleBinEntry>>('/api/v1/recyclebin');
    expect(bin.items.map((entry) => entry.originalPath).sort()).toEqual([dtsPath, mp4Path].sort());
  });

  test('step 6 - restoring the mp4 moves the row back and marks it ignored, so the next scan leaves it alone', async () => {
    const mkvPath = mp4Path.replace(/\.mp4$/, '.mkv');
    const bin = await call<Paginated<RecycleBinEntry>>('/api/v1/recyclebin');
    const entry = bin.items.find((item) => item.originalPath === mp4Path) as RecycleBinEntry;
    await call<RecycleBinEntry>(`/api/v1/recyclebin/${entry.id}/restore`, { method: 'POST' });

    expect(existsSync(mp4Path)).toBe(true);
    expect(existsSync(mkvPath)).toBe(false);
    const row = await mediaAt(mp4Path);
    expect(row).toMatchObject({ status: 'ignored', statusReason: 'restored from recycle bin' });
    const history = await call<Paginated<HistoryEntry>>(`/api/v1/history?mediaFileId=${row.id}&event=restored`);
    expect(history.total).toBe(1);

    await scan();
    expect((await mediaAt(mp4Path)).status).toBe('ignored');
    const jobs = await call<Paginated<JobSummary>>(`/api/v1/jobs?mediaFileId=${row.id}`);
    expect(jobs.items.every((job) => job.state !== 'queued' && job.state !== 'running')).toBe(true);
  });

  test('step 7 - removing a library cancels its queued jobs first', async () => {
    await call('/api/v1/queue/pause', { method: 'POST' });
    const strictRow = await mediaAt(join(strict, 'Strict.mkv'));
    const forced = await call<EnqueueResponse>('/api/v1/jobs', {
      method: 'POST',
      json: { mediaFileIds: [strictRow.id], force: true },
    });
    expect(forced.jobs).toHaveLength(1);
    const job = forced.jobs[0] as JobSummary;
    const library = (await call<Library[]>('/api/v1/libraries')).find((item) => item.name === 'Strict') as Library;

    await call(`/api/v1/libraries/${library.id}`, { method: 'DELETE' }, 204);

    const history = await call<Paginated<HistoryEntry>>(`/api/v1/history?jobId=${job.id}&event=cancelled`);
    expect(history.total).toBe(1);
    expect((await call<QueueResponse>('/api/v1/queue')).state).toMatchObject({ queued: 0, pauseReasons: ['user'] });
  });

  test('step 8 - recovery and housekeeping sweep orphaned temp paths under the real library roots', async () => {
    const leftover = join(movies, 'Dts Movie (2020)', 'Leftover.wololo-tmp.mkv');
    const discTemp = join(movies, '.wololo-tmp-999');
    mkdirSync(discTemp);
    writeFileSync(join(discTemp, 'part.mkv'), 'partial');
    expect(existsSync(leftover)).toBe(true);

    const recovered = await runtime.ctx.services.jobs.recover();
    expect(recovered.tempFilesDeleted).toBe(1);
    expect(existsSync(discTemp)).toBe(false);
    expect(existsSync(leftover)).toBe(true);

    await runtime.ctx.services.jobs.housekeeping();
    expect(existsSync(leftover)).toBe(false);
  });
});
