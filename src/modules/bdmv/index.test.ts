import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupSetup, conversionPlan, feature, JAMON, setup } from '../../../test/fixtures/bdmv/service.ts';
import { insertJob, insertLibrary, insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { DownloadClientService } from '../../contracts/integrations.ts';
import type { MediaService } from '../../contracts/probe-scan.ts';
import type { TorrentInfo } from '../../shared/domain.ts';
import { deleteSourceMessage } from './index.ts';

afterEach(cleanupSetup);
test('bdmv.detect - disc folder and non-disc path', async () => {
  const { t, disc, root } = setup();
  expect(await t.ctx.services.bdmv.detect(disc)).toEqual({ kind: 'bdmv', discRoot: disc });
  expect(await t.ctx.services.bdmv.detect(root)).toBeNull();
});

test('bdmv.evaluate - single main title becomes a needs_work plan into the Radarr root folder', async () => {
  const { t, root, disc, mediaFileId, calls } = setup();
  const evaluation = await t.ctx.services.bdmv.evaluate(mediaFileId);
  expect(evaluation.status).toBe('needs_work');
  expect(evaluation.decisionId).toBeNull();
  expect(evaluation.reason).toBe(
    `convert 00800.mpls (1h 35m 06s) to ${root}/Jamón Jamón (1992)/Jamón Jamón (1992).mkv`,
  );
  expect(evaluation.plan).toMatchObject({
    sourcePath: disc,
    sourceKind: 'bdmv',
    movie: JAMON,
    radarrInstanceId: 7,
    rootFolderPath: root,
    titles: [
      {
        playlist: '00800.mpls',
        role: 'main',
        edition: null,
        outputPath: `${root}/Jamón Jamón (1992)/Jamón Jamón (1992).mkv`,
      },
    ],
    dolbyVision: 'drop_hdr10',
    estimatedOutputBytes: 5000,
    extractBytes: 0,
  });
  expect(calls.lookupMovie?.[0]).toEqual([7, 'Jamon Jamon', 1992]);
  expect(calls.probe?.[0]).toEqual([disc, { playlist: '00800.mpls', signal: undefined }]);
});

test('bdmv.evaluate - disabled in settings is ignored', async () => {
  const { t, mediaFileId } = setup({ settings: { bdmv: { enabled: false } } });
  expect(await t.ctx.services.bdmv.evaluate(mediaFileId)).toEqual({
    status: 'ignored',
    reason: 'BDMV conversion is disabled',
    plan: null,
    decisionId: null,
  });
});

test('bdmv.evaluate - a disc with a completed bdmv job stays compatible', async () => {
  const { t, disc, mediaFileId } = setup();
  insertJob(t.ctx.db, { type: 'bdmv', state: 'completed', sourcePath: disc, mediaFileId, outputPath: '/m/X (1).mkv' });
  expect(await t.ctx.services.bdmv.evaluate(mediaFileId)).toMatchObject({
    status: 'compatible',
    reason: 'converted to /m/X (1).mkv',
  });
});

test('bdmv.evaluate - encrypted disc fails with the MakeMKV hint', async () => {
  const { t, mediaFileId } = setup({ files: { 'AACS/Unit_Key_RO.inf': 'k' } });
  expect(await t.ctx.services.bdmv.evaluate(mediaFileId)).toMatchObject({
    status: 'failed',
    reason: 'disc is encrypted (AACS/Unit_Key_RO.inf): decrypt with MakeMKV first',
  });
});

test('bdmv.evaluate - a disc without playlists fails', async () => {
  const { t, mediaFileId } = setup({ playlists: {} });
  expect((await t.ctx.services.bdmv.evaluate(mediaFileId)).reason).toBe('no playable playlist found on the disc');
});

test('bdmv.evaluate - two cuts within 5% create one pending main_title decision and emit an event', async () => {
  const { t, mediaFileId } = setup({
    playlists: { '00800.mpls': feature('00001', 6000), '00801.mpls': feature('00002', 5800) },
  });
  const events: unknown[] = [];
  t.ctx.events.on('bdmv.decision', (payload) => events.push(payload));
  const first = await t.ctx.services.bdmv.evaluate(mediaFileId);
  expect(first.status).toBe('needs_work');
  expect(first.plan).toBeNull();
  expect(first.decisionId).not.toBeNull();
  expect(first.reason).toStartWith('waiting for a decision: several playlists could be the main title');
  const second = await t.ctx.services.bdmv.evaluate(mediaFileId);
  expect(second.decisionId).toBe(first.decisionId);
  expect(events).toEqual([{ decisionId: first.decisionId, mediaFileId }]);
  const decision = await t.ctx.services.bdmv.getDecision(first.decisionId as number);
  expect(decision.titleCandidates.map((c) => c.playlist)).toEqual(['00800.mpls', '00801.mpls']);
  expect(decision.state).toBe('pending');
});

test('bdmv.evaluate - onAmbiguous editions exports every cut as a Plex edition', async () => {
  const { t, root, mediaFileId } = setup({
    settings: { bdmv: { onAmbiguous: 'editions' } },
    playlists: { '00800.mpls': feature('00001', 6000), '00801.mpls': feature('00002', 5800) },
  });
  const evaluation = await t.ctx.services.bdmv.evaluate(mediaFileId);
  expect(evaluation.plan?.titles).toEqual([
    {
      playlist: '00800.mpls',
      role: 'main',
      edition: 'Extended',
      outputPath: `${root}/Jamón Jamón (1992)/Jamón Jamón (1992) {edition-Extended}.mkv`,
    },
    {
      playlist: '00801.mpls',
      role: 'edition',
      edition: 'Theatrical',
      outputPath: `${root}/Jamón Jamón (1992)/Jamón Jamón (1992) {edition-Theatrical}.mkv`,
    },
  ]);
  expect(evaluation.plan?.estimatedOutputBytes).toBe(8000);
});

test('bdmv.resolveDecision - main_title choice re-evaluates through media.checkPath and is then used', async () => {
  const { t, disc, mediaFileId, calls } = setup({
    playlists: { '00800.mpls': feature('00001', 6000), '00801.mpls': feature('00002', 5800) },
  });
  const { decisionId } = await t.ctx.services.bdmv.evaluate(mediaFileId);
  const resolved = await t.ctx.services.bdmv.resolveDecision(decisionId as number, {
    kind: 'main_title',
    playlists: ['00801.mpls'],
    asEditions: false,
    editionNames: {},
  });
  expect(resolved.state).toBe('resolved');
  expect(resolved.resolvedAt).not.toBeNull();
  expect(calls.checkPath).toEqual([[disc, { trigger: 'manual' }]]);
  const evaluation = await t.ctx.services.bdmv.evaluate(mediaFileId);
  expect(evaluation.plan?.titles.map((title) => [title.playlist, title.role])).toEqual([['00801.mpls', 'main']]);
});

test('bdmv.resolveDecision - wrong kind is a validation error and a closed decision a conflict', async () => {
  const { t, mediaFileId } = setup({
    playlists: { '00800.mpls': feature('00001', 6000), '00801.mpls': feature('00002', 5800) },
  });
  const id = (await t.ctx.services.bdmv.evaluate(mediaFileId)).decisionId as number;
  await expect(t.ctx.services.bdmv.resolveDecision(id, { kind: 'movie_match', tmdbId: 1 })).rejects.toThrow(
    'is a main_title decision',
  );
  await t.ctx.services.bdmv.dismissDecision(id);
  await expect(t.ctx.services.bdmv.dismissDecision(id)).rejects.toThrow('already dismissed');
  await expect(t.ctx.services.bdmv.getDecision(9999)).rejects.toThrow('not found');
});

test('bdmv.dismissDecision - ignores the disc through media.setIgnored', async () => {
  const { t, mediaFileId, calls } = setup({
    playlists: { '00800.mpls': feature('00001', 6000), '00801.mpls': feature('00002', 5800) },
  });
  const id = (await t.ctx.services.bdmv.evaluate(mediaFileId)).decisionId as number;
  expect((await t.ctx.services.bdmv.dismissDecision(id)).state).toBe('dismissed');
  expect(calls.setIgnored).toEqual([[mediaFileId, true, 'BDMV decision dismissed']]);
});

test('bdmv.evaluate - a dismissed decision is asked again', async () => {
  const { t, mediaFileId } = setup({
    playlists: { '00800.mpls': feature('00001', 6000), '00801.mpls': feature('00002', 5800) },
  });
  const first = (await t.ctx.services.bdmv.evaluate(mediaFileId)).decisionId as number;
  await t.ctx.services.bdmv.dismissDecision(first);
  const second = (await t.ctx.services.bdmv.evaluate(mediaFileId)).decisionId;
  expect(second).not.toBe(first);
  expect(second).not.toBeNull();
});

test('bdmv.evaluate - low Radarr score asks for a movie_match decision with the candidates', async () => {
  const weak = { ...JAMON, score: 0.4 };
  const { t, mediaFileId } = setup({ lookups: [weak] });
  const evaluation = await t.ctx.services.bdmv.evaluate(mediaFileId);
  expect(evaluation.reason).toBe(
    'waiting for a decision: best Radarr match for "Jamon Jamon (1992)" is Jamón Jamón (1992) with score 0.40',
  );
  const decision = await t.ctx.services.bdmv.getDecision(evaluation.decisionId as number);
  expect(decision.kind).toBe('movie_match');
  expect(decision.movieCandidates).toEqual([weak]);
});

test('bdmv.evaluate - resolved movie_match looks the movie up by TMDB id', async () => {
  const weak = { ...JAMON, score: 0.4 };
  const { t, mediaFileId, calls } = setup({ lookups: [weak] });
  const id = (await t.ctx.services.bdmv.evaluate(mediaFileId)).decisionId as number;
  await t.ctx.services.bdmv.resolveDecision(id, { kind: 'movie_match', tmdbId: 4517 });
  const evaluation = await t.ctx.services.bdmv.evaluate(mediaFileId);
  expect(evaluation.status).toBe('needs_work');
  expect(evaluation.plan?.movie.tmdbId).toBe(4517);
  expect(calls.lookupMovie?.at(-1)).toEqual([7, 'tmdb:4517']);
});

test('bdmv.evaluate - the movie Radarr already links to the row wins over the score', async () => {
  const other = { ...JAMON, title: 'Other', tmdbId: 1, score: 0.99, radarrMovieId: 3 };
  const known = { ...JAMON, score: 0.5, radarrMovieId: 42 };
  const { t, mediaFileId } = setup({ lookups: [other, known] });
  t.ctx.dbHandle.sqlite.run(`update media_files set arr_kind = 'radarr', arr_item_id = 42 where id = ${mediaFileId}`);
  expect((await t.ctx.services.bdmv.evaluate(mediaFileId)).plan?.movie.radarrMovieId).toBe(42);
});

test('bdmv.evaluate - no Radarr instance fails', async () => {
  const { t, mediaFileId } = setup({ radarr: null });
  expect((await t.ctx.services.bdmv.evaluate(mediaFileId)).reason).toBe(
    'no enabled Radarr instance to identify and import the movie',
  );
});

test('bdmv.evaluate - a blocked rules plan fails but keeps the plan for the UI', async () => {
  const { t, mediaFileId } = setup({ plan: conversionPlan('blocked') });
  const evaluation = await t.ctx.services.bdmv.evaluate(mediaFileId);
  expect(evaluation.status).toBe('failed');
  expect(evaluation.reason).toBe('blocked: video codec vc1 not decoded by profile');
  expect(evaluation.plan?.audioPlan?.action).toBe('blocked');
});

test('bdmv.evaluate - upstream errors become a failed status', async () => {
  const { t, mediaFileId } = setup({
    arr: {
      lookupMovie: async () => {
        throw new Error('Radarr unreachable');
      },
    },
  });
  expect(await t.ctx.services.bdmv.evaluate(mediaFileId)).toMatchObject({
    status: 'failed',
    reason: 'BDMV evaluation failed: Radarr unreachable',
  });
});

test('bdmv.evaluate - settings.bdmv.rootFolderPath overrides Radarr root folders', async () => {
  const { t, mediaFileId } = setup({ settings: { bdmv: { rootFolderPath: '/data/bdmv-out' } } });
  expect((await t.ctx.services.bdmv.evaluate(mediaFileId)).plan?.rootFolderPath).toBe('/data/bdmv-out');
});

test('bdmv.evaluate - unknown media file is not_found, a plain file is unprocessable', async () => {
  const { t } = setup();
  await expect(t.ctx.services.bdmv.evaluate(9999)).rejects.toThrow('not found');
  const library = insertLibrary(t.ctx.db, { roots: [join(t.dir, 'other')] });
  const file = insertMediaFile(t.ctx.db, library, { kind: 'file' });
  await expect(t.ctx.services.bdmv.evaluate(file.id)).rejects.toThrow('is not a Blu-ray disc');
});

test('bdmv.analyze - playlist views with roles and duplicates', async () => {
  const { t, disc, mediaFileId } = setup({
    playlists: {
      '00800.mpls': feature('00001', 6000),
      '00801.mpls': feature('00001', 6000),
      '00010.mpls': feature('00002', 120),
    },
  });
  const info = await t.ctx.services.bdmv.analyze(mediaFileId);
  expect(info).toMatchObject({
    mediaFileId,
    path: disc,
    kind: 'bdmv',
    encrypted: false,
    encryptionMarkers: [],
    volumeLabel: null,
    mainPlaylist: '00800.mpls',
    needsDecision: false,
  });
  expect(info.playlists.map((p) => [p.playlist, p.role, p.duplicateOf, p.chapterCount])).toEqual([
    ['00800.mpls', 'main', null, 2],
    ['00801.mpls', 'ignored', '00800.mpls', 2],
    ['00010.mpls', 'ignored', null, 1],
  ]);
  expect(info.playlists[0]?.audioLanguages).toEqual(['spa']);
});

const TORRENT: TorrentInfo = {
  hash: 'abc123',
  name: 'Jamon.Jamon.1992.1080p.BluRay.x264-GRP',
  savePath: '/downloads',
  contentPath: '/downloads/Jamon',
  state: 'uploading',
  seeding: true,
  ratio: 2.034,
  seedingTimeSec: 3 * 86400,
  ratioLimit: 2,
  seedingTimeLimitSec: null,
  goalMet: true,
};

test('deleteSourceMessage - names the torrent, its ratio, seeding time and output', () => {
  expect(deleteSourceMessage(TORRENT, '/d/Jamon', '/m/J (1992).mkv')).toBe(
    '"Jamon.Jamon.1992.1080p.BluRay.x264-GRP" met its seeding goal (ratio 2.03, seeded 3 days). Delete the source /d/Jamon? It was converted to /m/J (1992).mkv.',
  );
  expect(deleteSourceMessage({ ...TORRENT, seedingTimeSec: 7200 }, '/d', null)).toContain('seeded 2 hours');
});

test('bdmv.offerSourceDeletion - only for converted discs with the setting on, once', async () => {
  const off = setup();
  insertJob(off.t.ctx.db, { type: 'bdmv', state: 'completed', sourcePath: off.disc, mediaFileId: off.mediaFileId });
  expect(await off.t.ctx.services.bdmv.offerSourceDeletion(off.mediaFileId, TORRENT)).toBeNull();
  cleanupSetup();

  const { t, disc, mediaFileId } = setup({ settings: { bdmv: { deleteSourceWhenSeeded: true } } });
  expect(await t.ctx.services.bdmv.offerSourceDeletion(mediaFileId, TORRENT)).toBeNull();
  insertJob(t.ctx.db, { type: 'bdmv', state: 'completed', sourcePath: disc, mediaFileId, outputPath: '/m/out.mkv' });
  const offer = await t.ctx.services.bdmv.offerSourceDeletion(mediaFileId, TORRENT);
  expect(offer).toMatchObject({ kind: 'delete_source', state: 'pending', sourcePath: disc });
  expect(offer?.message).toContain('It was converted to /m/out.mkv.');
  expect((await t.ctx.services.bdmv.offerSourceDeletion(mediaFileId, TORRENT))?.id).toBe(offer?.id as number);
  await t.ctx.services.bdmv.resolveDecision(offer?.id as number, { kind: 'delete_source', confirm: false });
  expect(await t.ctx.services.bdmv.offerSourceDeletion(mediaFileId, TORRENT)).toBeNull();
  expect(existsSync(disc)).toBe(true);
});

test('bdmv.deleteSource - refuses without a confirmed decision', async () => {
  const { t, mediaFileId } = setup();
  await expect(t.ctx.services.bdmv.deleteSource(mediaFileId)).rejects.toThrow('confirmed delete_source decision');
});

test('bdmv.resolveDecision - confirmed delete_source removes the folder and records history', async () => {
  const { t, disc, mediaFileId, calls } = setup({ settings: { bdmv: { deleteSourceWhenSeeded: true } } });
  insertJob(t.ctx.db, { type: 'bdmv', state: 'completed', sourcePath: disc, mediaFileId, outputPath: '/m/out.mkv' });
  const offer = await t.ctx.services.bdmv.offerSourceDeletion(mediaFileId, TORRENT);
  expect(existsSync(disc)).toBe(true);
  await t.ctx.services.bdmv.resolveDecision(offer?.id as number, { kind: 'delete_source', confirm: true });
  expect(existsSync(disc)).toBe(false);
  expect(calls.addHistory?.[0]?.[0]).toMatchObject({ event: 'source_deleted', path: disc, mediaFileId, data: null });
});

test('bdmv.deleteSource - a torrent that owns the path is removed with its files instead', async () => {
  const { t, disc, mediaFileId, calls } = setup({
    settings: { bdmv: { deleteSourceWhenSeeded: true } },
    torrent: TORRENT,
  });
  insertJob(t.ctx.db, { type: 'bdmv', state: 'completed', sourcePath: disc, mediaFileId });
  const offer = await t.ctx.services.bdmv.offerSourceDeletion(mediaFileId, TORRENT);
  await t.ctx.services.bdmv.resolveDecision(offer?.id as number, { kind: 'delete_source', confirm: true });
  expect(calls.deleteTorrent).toEqual([['abc123', true]]);
  expect(existsSync(disc)).toBe(true);
  expect(calls.addHistory?.[0]?.[0]).toMatchObject({ event: 'source_deleted', data: { torrentHash: 'abc123' } });
});

test('bdmv.deleteSource - refuses to delete a library root or an unconverted disc', async () => {
  const { t, root, mediaFileId, disc } = setup({ settings: { bdmv: { deleteSourceWhenSeeded: true } } });
  insertJob(t.ctx.db, { type: 'bdmv', state: 'completed', sourcePath: disc, mediaFileId });
  const offer = await t.ctx.services.bdmv.offerSourceDeletion(mediaFileId, TORRENT);
  t.ctx.dbHandle.sqlite.run(
    `update bdmv_decisions set state = 'resolved', choice = '{"kind":"delete_source","confirm":true}'`,
  );
  t.ctx.dbHandle.sqlite.run(`update media_files set path = '${root}' where id = ${mediaFileId}`);
  expect(offer).not.toBeNull();
  await expect(t.ctx.services.bdmv.deleteSource(mediaFileId)).rejects.toThrow('it is a library root');
  t.ctx.dbHandle.sqlite.run(`update media_files set path = '${disc}' where id = ${mediaFileId}`);
  t.ctx.dbHandle.sqlite.run('delete from jobs');
  await expect(t.ctx.services.bdmv.deleteSource(mediaFileId)).rejects.toThrow('no completed conversion');
  expect(existsSync(disc)).toBe(true);
});

test('routes - list, get, resolve validation, dismiss and disc analysis', async () => {
  const { t, mediaFileId } = setup({
    playlists: { '00800.mpls': feature('00001', 6000), '00801.mpls': feature('00002', 5800) },
  });
  const id = (await t.ctx.services.bdmv.evaluate(mediaFileId)).decisionId as number;

  const list = await t.request('/api/v1/bdmv/decisions?state=pending');
  expect(list.status).toBe(200);
  expect(((await list.json()) as { id: number }[]).map((d) => d.id)).toEqual([id]);
  expect((await t.request('/api/v1/bdmv/decisions?state=bogus')).status).toBe(400);
  expect((await t.request('/api/v1/bdmv/decisions?state=resolved').then((r) => r.json())) as unknown[]).toEqual([]);

  const one = await t.request(`/api/v1/bdmv/decisions/${id}`);
  expect(((await one.json()) as { kind: string }).kind).toBe('main_title');
  expect((await t.request('/api/v1/bdmv/decisions/999')).status).toBe(404);
  expect((await t.request('/api/v1/bdmv/decisions/abc')).status).toBe(400);

  const invalid = await t.request(`/api/v1/bdmv/decisions/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'main_title', playlists: ['../etc/passwd'] }),
  });
  expect(invalid.status).toBe(400);
  const body = await invalid.text();
  expect(body).not.toContain('select');

  const resolved = await t.request(`/api/v1/bdmv/decisions/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'main_title', playlists: ['00800.mpls'] }),
  });
  expect(resolved.status).toBe(200);
  expect(((await resolved.json()) as { choice: unknown }).choice).toEqual({
    kind: 'main_title',
    playlists: ['00800.mpls'],
    asEditions: false,
    editionNames: {},
  });
  const again = await t.request(`/api/v1/bdmv/decisions/${id}/dismiss`, { method: 'POST' });
  expect(again.status).toBe(409);

  const disc = await t.request(`/api/v1/bdmv/discs/${mediaFileId}`);
  expect(disc.status).toBe(200);
  expect(((await disc.json()) as { mainPlaylist: string }).mainPlaylist).toBe('00800.mpls');
  expect((await t.request('/api/v1/bdmv/discs/4242')).status).toBe(404);
});

test('bdmv.resolveDecision - a failed deletion leaves the decision pending for a retry', async () => {
  const { t, disc, mediaFileId } = setup({
    settings: { bdmv: { deleteSourceWhenSeeded: true } },
    overrides: {
      downloadClient: stubService<DownloadClientService>('downloadClient', {
        findTorrentByPath: async () => TORRENT,
        deleteTorrent: async () => {
          throw new Error('qBittorrent unreachable');
        },
      }),
    },
  });
  insertJob(t.ctx.db, { type: 'bdmv', state: 'completed', sourcePath: disc, mediaFileId });
  const offer = await t.ctx.services.bdmv.offerSourceDeletion(mediaFileId, TORRENT);
  const id = offer?.id as number;
  await expect(t.ctx.services.bdmv.resolveDecision(id, { kind: 'delete_source', confirm: true })).rejects.toThrow(
    'qBittorrent unreachable',
  );
  expect((await t.ctx.services.bdmv.getDecision(id)).state).toBe('pending');
});

test('bdmv.resolveDecision - a failing re-evaluation is logged, the choice is kept', async () => {
  const { t, mediaFileId } = setup({
    playlists: { '00800.mpls': feature('00001', 6000), '00801.mpls': feature('00002', 5800) },
    overrides: {
      media: stubService<MediaService>('media', {
        checkPath: async () => {
          throw new Error('scanner busy');
        },
      }),
    },
  });
  const id = (await t.ctx.services.bdmv.evaluate(mediaFileId)).decisionId as number;
  const resolved = await t.ctx.services.bdmv.resolveDecision(id, {
    kind: 'main_title',
    playlists: ['00800.mpls'],
    asEditions: false,
    editionNames: {},
  });
  expect(resolved.state).toBe('resolved');
  expect(t.ctx.logs.entries({ module: 'bdmv', level: 'error' }).map((entry) => entry.message)).toContain(
    're-evaluating a BDMV disc after a decision failed',
  );
});
