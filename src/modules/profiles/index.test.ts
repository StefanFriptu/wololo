import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertLibrary, insertProfile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { MediaService } from '../../contracts/probe-scan.ts';
import { DEFAULT_PROFILE_NAME } from '../../contracts/rules-ffmpeg.ts';
import { AppError } from '../../core/errors.ts';
import type { ProfileInput } from '../../shared/api-types.ts';
import type { DeviceProfileDefinition } from '../../shared/domain.ts';
import { samsungTizenDefinition } from './defaults.ts';

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
  const base = samsungTizenDefinition();
  return { ...base, audio: { ...base.audio, maxChannels: 2 } };
}

function input(name: string, definition = samsungTizenDefinition()): ProfileInput {
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

test('profiles.ensureDefaults - seeds the builtin Samsung Tizen profile once', async () => {
  await profiles().ensureDefaults();
  await profiles().ensureDefaults();
  const list = await profiles().list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({
    name: DEFAULT_PROFILE_NAME,
    builtin: true,
    version: 1,
    definition: samsungTizenDefinition(),
    libraryIds: [],
  });
});

test('profiles.ensureDefaults - leaves existing profiles alone', async () => {
  insertProfile(t.ctx.db, stereoOnly(), { name: 'custom' });
  await profiles().ensureDefaults();
  expect((await profiles().list()).map((profile) => profile.name)).toEqual(['custom']);
});

test('profiles.getDefault - returns the builtin profile, seeding it when the table is empty', async () => {
  const seeded = await profiles().getDefault();
  expect(seeded).toMatchObject({ name: DEFAULT_PROFILE_NAME, builtin: true });
  await profiles().create(input('Other'));
  expect((await profiles().getDefault()).id).toBe(seeded.id);
});

test('profiles.create - stores a non-builtin profile at version 1', async () => {
  const created = await profiles().create(input('Bedroom', stereoOnly()));
  expect(created).toMatchObject({
    name: 'Bedroom',
    description: 'bedroom TV',
    version: 1,
    builtin: false,
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
  const { audio, video, subtitles, container } = samsungTizenDefinition();
  const reordered = { container, subtitles, video, audio: { ...audio } };
  expect((await profiles().update(created.id, input('Bedroom', reordered))).version).toBe(1);
});

test('profiles.update - editing the builtin default also invalidates libraries without profiles', async () => {
  const builtin = await profiles().getDefault();
  const other = await profiles().create(input('Other'));
  const implicit = insertLibrary(t.ctx.db, { roots: ['/data/media/movies'] });
  insertLibrary(t.ctx.db, { roots: ['/data/media/tv'], profileIds: [other.id] });
  const toggledFlac = samsungTizenDefinition();
  toggledFlac.audio.allowedCodecs.push('flac');
  const updated = await profiles().update(builtin.id, input(DEFAULT_PROFILE_NAME, toggledFlac));
  expect(updated).toMatchObject({ builtin: true, version: 2 });
  expect(invalidations).toEqual([{ profileId: builtin.id }, { libraryId: implicit.libraryId }]);
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

test('profiles.remove - the builtin profile is a conflict', async () => {
  const builtin = await profiles().getDefault();
  await expectAppError(profiles().remove(builtin.id), 'conflict');
});

test('profiles.remove - an assigned profile is a conflict', async () => {
  const created = await profiles().create(input('Bedroom'));
  insertLibrary(t.ctx.db, { profileIds: [created.id] });
  await expectAppError(profiles().remove(created.id), 'conflict');
  expect((await profiles().get(created.id)).name).toBe('Bedroom');
});

test('profiles.clone - copies the definition into a new editable profile', async () => {
  const builtin = await profiles().getDefault();
  const clone = await profiles().clone(builtin.id, 'Living room');
  expect(clone).toMatchObject({
    name: 'Living room',
    description: builtin.description,
    builtin: false,
    version: 1,
    definition: builtin.definition,
    libraryIds: [],
  });
  expect(clone.id).not.toBe(builtin.id);
});

test('profiles.clone - a taken name is a conflict', async () => {
  const builtin = await profiles().getDefault();
  await expectAppError(profiles().clone(builtin.id, DEFAULT_PROFILE_NAME), 'conflict');
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
