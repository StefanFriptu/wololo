import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertLibrary } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { MediaService } from '../../contracts/probe-scan.ts';
import { AppError } from '../../core/errors.ts';
import type { ProfileInput } from '../../shared/api-types.ts';
import type { DeviceProfileDefinition } from '../../shared/domain.ts';
import { templateDefinition } from './profileTemplates.ts';

let t: TestContext;
let invalidations: { libraryId?: number; profileId?: number }[];
let invalidationFails: boolean;

beforeEach(() => {
  invalidations = [];
  invalidationFails = false;
  t = createTestContext({
    overrides: {
      media: stubService<MediaService>('media', {
        invalidateRules: async (filter) => {
          if (invalidationFails) throw new Error('media not ready');
          invalidations.push(filter);
          return 0;
        },
      }),
    },
  });
});

afterEach(() => t.cleanup());

const profiles = () => t.ctx.services.profiles;

function stereoOnly(): DeviceProfileDefinition {
  const base = templateDefinition('basic');
  return { ...base, audio: { ...base.audio, maxChannels: 2 } };
}

function input(name: string, definition = templateDefinition('basic')): ProfileInput {
  return { name, description: 'bedroom TV', definition };
}

async function expectAppError(promise: Promise<unknown>, code: AppError['code']) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

test('profiles.list - a fresh install has no profiles', async () => {
  expect(await profiles().list()).toEqual([]);
});

test('profiles.create - stores a profile at version 1', async () => {
  const created = await profiles().create(input('Bedroom', stereoOnly()));
  expect(created).toMatchObject({
    name: 'Bedroom',
    description: 'bedroom TV',
    version: 1,
    definition: stereoOnly(),
    libraryIds: [],
  });
  expect(await profiles().get(created.id)).toEqual(created);
});

test('profiles.create - a duplicate name is a conflict', async () => {
  await profiles().create(input('Bedroom'));
  await expectAppError(profiles().create(input('Bedroom')), 'conflict');
});

test('profiles.list - reports the libraries each profile is assigned to', async () => {
  const a = await profiles().create(input('A'));
  const b = await profiles().create(input('B'));
  const first = insertLibrary(t.ctx.db, { roots: ['/data/media/movies'], profileIds: [a.id, b.id] });
  const second = insertLibrary(t.ctx.db, { roots: ['/data/media/tv'], profileIds: [a.id] });
  const list = await profiles().list();
  expect(list.map((profile) => [profile.name, profile.libraryIds])).toEqual([
    ['A', [first.libraryId, second.libraryId]],
    ['B', [first.libraryId]],
  ]);
  expect((await profiles().get(b.id)).libraryIds).toEqual([first.libraryId]);
});

test('profiles.get - an unknown id is not found', async () => {
  await expectAppError(profiles().get(999), 'not_found');
});

test('profiles.update - a definition change bumps the version and invalidates the rules of its files', async () => {
  const created = await profiles().create(input('Bedroom'));
  const updated = await profiles().update(created.id, input('Bedroom', stereoOnly()));
  expect(updated.version).toBe(2);
  expect(updated.definition.audio.maxChannels).toBe(2);
  expect(invalidations).toEqual([{ profileId: created.id }]);
});

test('profiles.update - renaming keeps the version and invalidates nothing', async () => {
  const created = await profiles().create(input('Bedroom'));
  const renamed = await profiles().update(created.id, { ...input('Guest room'), description: 'guest TV' });
  expect(renamed).toMatchObject({ name: 'Guest room', description: 'guest TV', version: 1 });
  expect(invalidations).toEqual([]);
});

test('profiles.update - key order of an equal definition is not a change', async () => {
  const created = await profiles().create(input('Bedroom'));
  const { audio, video, subtitles, container } = templateDefinition('basic');
  const reordered = { container, subtitles, video, audio: { ...audio } };
  expect((await profiles().update(created.id, input('Bedroom', reordered))).version).toBe(1);
});

test('profiles.update - a definition change invalidates only the libraries using that profile', async () => {
  const edited = await profiles().create(input('Edited'));
  const other = await profiles().create(input('Other'));
  insertLibrary(t.ctx.db, { roots: ['/data/media/movies'] });
  insertLibrary(t.ctx.db, { roots: ['/data/media/tv'], profileIds: [other.id] });
  const toggledFlac = templateDefinition('basic');
  toggledFlac.audio.allowedCodecs.push('flac');
  expect((await profiles().update(edited.id, input('Edited', toggledFlac))).version).toBe(2);
  expect(invalidations).toEqual([{ profileId: edited.id }]);
});

test('profiles.update - a failing invalidation does not undo the saved edit', async () => {
  const created = await profiles().create(input('Bedroom'));
  invalidationFails = true;
  const updated = await profiles().update(created.id, input('Bedroom', stereoOnly()));
  expect(updated.version).toBe(2);
  expect((await profiles().get(created.id)).version).toBe(2);
  const warnings = t.ctx.logs.entries({ module: 'profiles' }).filter((entry) => entry.level === 'warn');
  expect(warnings.map((entry) => entry.message)).toEqual([
    'rules invalidation failed; the next scan re-checks these files by rules key',
  ]);
});

test('profiles.update - taking another profile name is a conflict', async () => {
  await profiles().create(input('A'));
  const b = await profiles().create(input('B'));
  await expectAppError(profiles().update(b.id, input('A')), 'conflict');
});

test('profiles.update - an unknown id is not found', async () => {
  await expectAppError(profiles().update(999, input('X')), 'not_found');
});

test('profiles.remove - deletes an unassigned profile', async () => {
  const created = await profiles().create(input('Bedroom'));
  await profiles().remove(created.id);
  await expectAppError(profiles().get(created.id), 'not_found');
});

test('profiles.remove - an assigned profile is a conflict', async () => {
  const created = await profiles().create(input('Bedroom'));
  insertLibrary(t.ctx.db, { profileIds: [created.id] });
  await expectAppError(profiles().remove(created.id), 'conflict');
  expect((await profiles().get(created.id)).name).toBe('Bedroom');
});

test('profiles.clone - copies the definition into a new editable profile', async () => {
  const source = await profiles().create(input('Living room TV', stereoOnly()));
  const clone = await profiles().clone(source.id, 'Living room');
  expect(clone).toMatchObject({
    name: 'Living room',
    description: source.description,
    version: 1,
    definition: source.definition,
    libraryIds: [],
  });
  expect(clone.id).not.toBe(source.id);
});

test('profiles.clone - a taken name is a conflict', async () => {
  const source = await profiles().create(input('Bedroom'));
  await expectAppError(profiles().clone(source.id, 'Bedroom'), 'conflict');
});

test('profiles.templates - offers the format templates, never a device', () => {
  expect(
    profiles()
      .templates()
      .map((template) => template.name),
  ).toEqual(['Basic', 'Dolby', 'Lossless', 'Everything', 'Blank']);
});

test('profiles.codecCatalog - lists audio, video and subtitle codecs with the pcm wildcard', () => {
  const catalog = profiles().codecCatalog();
  expect(catalog.audio.map((codec) => codec.codec)).toEqual(
    expect.arrayContaining(['ac3', 'eac3', 'aac', 'mp3', 'dts', 'truehd', 'flac', 'pcm_*', 'opus', 'vorbis']),
  );
  expect(catalog.audio.every((codec) => codec.kind === 'audio')).toBe(true);
  expect(catalog.video.map((codec) => codec.codec)).toContain('hevc');
  expect(catalog.subtitle.map((codec) => codec.codec)).toContain('hdmv_pgs_subtitle');
});
