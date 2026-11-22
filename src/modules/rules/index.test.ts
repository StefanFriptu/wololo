import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertLibrary, insertProfile } from '../../../test/helpers/seed.ts';
import { AppError } from '../../core/errors.ts';
import type { DeviceProfileDefinition } from '../../shared/domain.ts';
import { templateDefinition } from '../profiles/profileTemplates.ts';

let t: TestContext;

beforeEach(() => {
  t = createTestContext();
});

afterEach(() => t.cleanup());

function stereoOnly(): DeviceProfileDefinition {
  const base = templateDefinition('basic');
  return { ...base, audio: { ...base.audio, maxChannels: 2 } };
}

test('rules.effectiveProfileForLibrary - a library without profiles has none', async () => {
  const { libraryId } = insertLibrary(t.ctx.db);
  expect(await t.ctx.services.rules.effectiveProfileForLibrary(libraryId)).toBeNull();
  expect(await t.ctx.services.rules.profilesForLibrary(libraryId)).toEqual([]);
});

test('rules.effectiveProfileForLibrary - assigned profiles resolve to the strictest combination', async () => {
  const basic = insertProfile(t.ctx.db, templateDefinition('basic'), { name: 'Basic' });
  const stereo = insertProfile(t.ctx.db, stereoOnly(), { name: 'Stereo' });
  const { libraryId } = insertLibrary(t.ctx.db, { profileIds: [stereo, basic] });
  const effective = await t.ctx.services.rules.effectiveProfileForLibrary(libraryId);
  expect(effective?.profileIds).toEqual([basic, stereo]);
  expect(effective?.versionKey).toBe(`${basic}@1+${stereo}@1`);
  expect(effective?.definition.audio.maxChannels).toBe(2);
});

test('rules.effectiveProfileForLibrary - a profile id converts for that profile alone', async () => {
  const basic = insertProfile(t.ctx.db, templateDefinition('basic'), { name: 'Basic' });
  const stereo = insertProfile(t.ctx.db, stereoOnly(), { name: 'Stereo' });
  const { libraryId } = insertLibrary(t.ctx.db, { profileIds: [stereo, basic] });
  const effective = await t.ctx.services.rules.effectiveProfileForLibrary(libraryId, basic);
  expect(effective).toEqual({ profileIds: [basic], versionKey: `${basic}@1`, definition: templateDefinition('basic') });
});

test('rules.effectiveProfileForLibrary - a profile the library does not use is unprocessable', async () => {
  const basic = insertProfile(t.ctx.db, templateDefinition('basic'), { name: 'Basic' });
  const other = insertProfile(t.ctx.db, stereoOnly(), { name: 'Other' });
  const { libraryId } = insertLibrary(t.ctx.db, { profileIds: [basic] });
  const error = await t.ctx.services.rules
    .effectiveProfileForLibrary(libraryId, other)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe('unprocessable');
});

test('rules.effectiveProfileForLibrary - an unknown library is not found', async () => {
  const error = await t.ctx.services.rules.effectiveProfileForLibrary(999).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe('not_found');
});

test('rules.rulesKey - is the pure computeRulesKey', () => {
  const { rules } = t.ctx.services;
  expect(
    rules.rulesKey(
      { profileIds: [1], versionKey: '1@1', definition: templateDefinition('basic') },
      {
        mode: 'replace',
        keepLanguages: [],
        keepOriginalLanguage: true,
        keepUndetermined: true,
        fillMissingLanguage: 'off',
      },
    ),
  ).toBe('r1;p1@1;m:replace;k:;o:1;u:1;f:off');
});
