import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DryRunReport,
  EnqueueResponse,
  MediaFileSummary,
  Paginated,
  ProfileWithUsage,
} from '../../src/shared/api-types.ts';
import type { HistoryEntry, JobSummary, Library } from '../../src/shared/domain.ts';
import { ensureFixtureCopy, FIXTURES, type FixtureSpec, ffmpegAvailable } from '../helpers/fixtures.ts';
import {
  type ApiCall,
  apiClient,
  eventually,
  ffprobeJson,
  type InProcessServer,
  startInProcessServer,
  streamHash,
} from '../helpers/server.ts';

interface AudioStream {
  codec_type: string;
  codec_name: string;
  channels: number;
  bit_rate?: string;
  disposition: { default: number };
  tags?: { language?: string };
}

const SPANISH_ONLY: FixtureSpec = {
  name: 'integration-spanish-only',
  audio: [{ codec: 'dts', layout: 'stereo', language: 'spa' }],
};

let dir: string;
let server: InProcessServer;
let call: ApiCall;
let paths: Record<'flac71' | 'stereo' | 'mono' | 'compatible' | 'keepBoth' | 'spanish', string>;
let flac71Before: { hash: string; mode: number; uid: number };

async function audio(path: string): Promise<[string, number, string | undefined][]> {
  const probe = await ffprobeJson<{ streams: AudioStream[] }>(path);
  return probe.streams
    .filter((stream) => stream.codec_type === 'audio')
    .map((stream) => [stream.codec_name, stream.channels, stream.bit_rate]);
}

async function mediaAt(path: string): Promise<MediaFileSummary> {
  const page = await call<Paginated<MediaFileSummary>>('/api/v1/media?pageSize=500');
  const found = page.items.find((item) => item.path === path);
  if (!found) throw new Error(`no media row for ${path}: ${JSON.stringify(page.items.map((item) => item.path))}`);
  return found;
}

async function scan(): Promise<void> {
  await call('/api/v1/scans', { method: 'POST', json: {} });
  await eventually(
    'scan finished',
    () => call<{ running: boolean } | null>('/api/v1/scans/current'),
    (current) => !current?.running,
  );
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[path] = `${statSync(path).size}:${statSync(path).mtimeMs}`;
    }
  };
  walk(root);
  return files;
}

async function statusesByLibrary(): Promise<Record<string, string>> {
  const page = await call<Paginated<MediaFileSummary>>('/api/v1/media?pageSize=500');
  return Object.fromEntries(page.items.map((item) => [item.path, `${item.libraryId}:${item.status}`]));
}

describe.skipIf(!ffmpegAvailable())('real server: Feature 1 track rules across libraries', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wololo-feature1-'));
    const media = join(dir, 'media');
    paths = {
      flac71: await ensureFixtureCopy(FIXTURES.flac71, join(media, 'movies', 'Wide (2018)'), 'Wide (2018).mkv'),
      stereo: await ensureFixtureCopy(FIXTURES.eac3Stereo, join(media, 'movies', 'Two (2017)'), 'Two (2017).mkv'),
      mono: await ensureFixtureCopy(FIXTURES.flacMono, join(media, 'movies', 'One (2016)'), 'One (2016).mkv'),
      compatible: await ensureFixtureCopy(FIXTURES.ac3Compatible, join(media, 'movies', 'Fine (2015)'), 'Fine.mkv'),
      keepBoth: await ensureFixtureCopy(FIXTURES.multiLanguage, join(media, 'keep'), 'Multi (2014).mkv'),
      spanish: await ensureFixtureCopy(SPANISH_ONLY, join(media, 'filtered'), 'Spanish (2013).mkv'),
    };
    chmodSync(paths.flac71, 0o640);
    const stat = statSync(paths.flac71);
    flac71Before = { hash: await streamHash(paths.flac71), mode: stat.mode & 0o7777, uid: stat.uid };

    server = await startInProcessServer(dir);
    call = apiClient(
      () => server.base,
      () => server.apiKey,
    );
    const library = (name: string, root: string, extra: object = {}) =>
      call<Library>('/api/v1/libraries', {
        method: 'POST',
        json: { name, kind: 'movies', roots: [join(media, root)], profileIds: [], ...extra },
      });
    await library('Movies', 'movies');
    await library('Keep', 'keep', { mode: 'keep_both' });
    await library('Filtered', 'filtered', { keepLanguages: ['eng'], keepOriginalLanguage: false });
  });

  afterAll(async () => {
    await server?.runtime.stop('test');
    rmSync(dir, { recursive: true, force: true });
  });

  test('step 1 - the dry run reports failing codecs with time and space estimates and writes nothing', async () => {
    const before = snapshot(join(dir, 'media'));
    await scan();
    const report = await call<DryRunReport>('/api/v1/dryrun');
    expect(report.totals).toMatchObject({ files: 6, compatible: 1, needsWork: 5, failed: 0 });
    expect(report.groups.map((group) => [group.codec, group.files]).sort()).toEqual([
      ['dts', 2],
      ['eac3', 1],
      ['flac', 2],
    ]);
    expect(report.estimatedSeconds).toBeGreaterThan(0);
    expect(report.estimatedExtraBytes).toBeGreaterThan(0);
    expect(snapshot(join(dir, 'media'))).toEqual(before);
  });

  test('step 2 - processing every needs-work file completes each job', async () => {
    await call('/api/v1/settings', { method: 'PUT', json: { processing: { enabled: true } } });
    const queued = await call<EnqueueResponse>('/api/v1/jobs', {
      method: 'POST',
      json: { filter: { status: 'needs_work' } },
    });
    expect(queued.jobs).toHaveLength(5);
    const done = await eventually(
      'jobs finished',
      () => call<Paginated<JobSummary>>('/api/v1/jobs?state=completed,failed,cancelled'),
      (page) => page.total === 5,
    );
    expect(done.items.map((job) => [job.title, job.state, job.error])).toEqual(
      done.items.map((job) => [job.title, 'completed', null]),
    );
  });

  test('step 3 - 7.1 becomes AC3 5.1 640 kbps with the downmix noted, video, owner and mode kept', async () => {
    expect(await audio(paths.flac71)).toEqual([['ac3', 6, '640000']]);
    expect(await streamHash(paths.flac71)).toBe(flac71Before.hash);
    const stat = statSync(paths.flac71);
    expect({ mode: stat.mode & 0o7777, uid: stat.uid }).toEqual({ mode: flac71Before.mode, uid: flac71Before.uid });
    const row = await mediaAt(paths.flac71);
    const history = await call<Paginated<HistoryEntry>>(`/api/v1/history?mediaFileId=${row.id}&event=completed`);
    expect(history.items[0]?.data?.lostFeatures).toContain('7.1 downmixed to 5.1');
  });

  test('step 4 - stereo becomes AC3 2.0 448 kbps and mono AC3 1.0 192 kbps', async () => {
    expect(await audio(paths.stereo)).toEqual([['ac3', 2, '448000']]);
    expect(await audio(paths.mono)).toEqual([['ac3', 1, '192000']]);
  });

  test('step 5 - keep both puts the converted track first as the only default and keeps the original', async () => {
    const probe = await ffprobeJson<{ streams: AudioStream[] }>(paths.keepBoth);
    const tracks = probe.streams
      .filter((stream) => stream.codec_type === 'audio')
      .map((stream) => [stream.codec_name, stream.tags?.language, stream.disposition.default]);
    expect(tracks).toEqual([
      ['ac3', 'spa', 1],
      ['dts', 'spa', 0],
      ['ac3', 'eng', 0],
      ['aac', 'ger', 0],
    ]);
  });

  test('step 6 - the language filter never removes the last audio track', async () => {
    expect(await audio(paths.spanish)).toEqual([['ac3', 2, '448000']]);
  });

  test('step 7 - a compatible file is marked compatible and never written', async () => {
    const before = statSync(paths.compatible);
    expect((await mediaAt(paths.compatible)).status).toBe('compatible');
    const jobs = await call<Paginated<JobSummary>>(`/api/v1/jobs?mediaFileId=${(await mediaAt(paths.compatible)).id}`);
    expect(jobs.total).toBe(0);
    const after = statSync(paths.compatible);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });

  test('step 8 - converted files are never processed twice', async () => {
    const jobsBefore = (await call<Paginated<JobSummary>>('/api/v1/jobs')).total;
    expect(jobsBefore).toBe(5);
    await scan();
    expect((await call<Paginated<JobSummary>>('/api/v1/jobs')).total).toBe(jobsBefore);
    const again = await call<EnqueueResponse>('/api/v1/jobs', {
      method: 'POST',
      json: { mediaFileIds: [(await mediaAt(paths.flac71)).id] },
    });
    expect(again).toMatchObject({ jobs: [], skipped: [{ reason: 'status is compatible' }] });
  });

  test('step 9 - editing a profile re-checks only the files of libraries that use it', async () => {
    await call('/api/v1/queue/pause', { method: 'POST' });
    const [tizen] = await call<ProfileWithUsage[]>('/api/v1/profiles');
    if (!tizen) throw new Error('no default profile');
    const strict = await call<ProfileWithUsage>('/api/v1/profiles', {
      method: 'POST',
      json: { name: 'No AAC', definition: tizen.definition },
    });
    const keep = (await call<Library[]>('/api/v1/libraries')).find((library) => library.name === 'Keep') as Library;
    await call(`/api/v1/libraries/${keep.id}`, {
      method: 'PUT',
      json: { name: keep.name, kind: keep.kind, roots: [join(dir, 'media', 'keep')], profileIds: [strict.id] },
    });
    await scan();
    const before = await statusesByLibrary();
    expect(Object.values(before).every((status) => status.endsWith(':compatible'))).toBe(true);

    await call(`/api/v1/profiles/${strict.id}`, {
      method: 'PUT',
      json: {
        name: 'No AAC',
        definition: { ...tizen.definition, audio: { ...tizen.definition.audio, allowedCodecs: ['ac3', 'mp3'] } },
      },
    });
    const after = await statusesByLibrary();
    const changed = Object.keys(after).filter((path) => after[path] !== before[path]);
    expect(changed).toEqual([paths.keepBoth]);
    expect(after[paths.keepBoth]).toBe(`${keep.id}:pending`);

    await scan();
    expect(await mediaAt(paths.keepBoth)).toMatchObject({ status: 'needs_work', failingCodecs: ['dts', 'aac'] });
  });
});
