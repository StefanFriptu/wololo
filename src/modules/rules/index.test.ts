import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertLibrary, insertProfile } from '../../../test/helpers/seed.ts';
import { AppError } from '../../core/errors.ts';
import type { DeviceProfileDefinition } from '../../shared/domain.ts';
import { samsungTizenDefinition } from '../profiles/defaults.ts';

let t: TestContext;

beforeEach(() => {
  t = createTestContext();
});

afterEach(() => t.cleanup());

function stereoOnly(): DeviceProfileDefinition {
  const base = samsungTizenDefinition();
  return { ...base, audio: { ...base.audio, maxChannels: 2 } };
}

test('rules.effectiveProfileForLibrary - a library without profiles uses the default profile', async () => {
  const { libraryId } = insertLibrary(t.ctx.db);
  const effective = await t.ctx.services.rules.effectiveProfileForLibrary(libraryId);
  const fallback = await t.ctx.services.profiles.getDefault();
  expect(effective).toEqual({
    profileIds: [fallback.id],
    versionKey: `${fallback.id}@1`,
    definition: samsungTizenDefinition(),
  });
});

test('rules.effectiveProfileForLibrary - assigned profiles resolve to the strictest combination', async () => {
  await t.ctx.services.profiles.ensureDefaults();
  const tizen = insertProfile(t.ctx.db, samsungTizenDefinition(), { name: 'Tizen copy' });
  const stereo = insertProfile(t.ctx.db, stereoOnly(), { name: 'Stereo' });
  const { libraryId } = insertLibrary(t.ctx.db, { profileIds: [stereo, tizen] });
  const effective = await t.ctx.services.rules.effectiveProfileForLibrary(libraryId);
  expect(effective.profileIds).toEqual([tizen, stereo]);
  expect(effective.versionKey).toBe(`${tizen}@1+${stereo}@1`);
  expect(effective.definition.audio.maxChannels).toBe(2);
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
      { profileIds: [1], versionKey: '1@1', definition: samsungTizenDefinition() },
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
