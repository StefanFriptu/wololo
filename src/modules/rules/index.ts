import type { AppContext } from '../../app/context.ts';
import type { RulesService } from '../../contracts/rules-ffmpeg.ts';
import { notFound } from '../../core/errors.ts';
import { profileQuery } from '../profiles/profileQuery.ts';
import { computeRulesKey, planConversion, resolveEffectiveProfile } from './engine.ts';

export function createRulesService(ctx: AppContext): RulesService {
  const query = profileQuery(ctx.db);
  return {
    plan: planConversion,
    resolveProfile: resolveEffectiveProfile,
    rulesKey: computeRulesKey,
    effectiveProfileForLibrary: async (libraryId) => {
      if (!query.libraryExists(libraryId)) throw notFound(`library ${libraryId}`);
      const assigned = query.assignedToLibrary(libraryId);
      const profiles = assigned.length > 0 ? assigned : [await ctx.services.profiles.getDefault()];
      return resolveEffectiveProfile(profiles);
    },
  };
}
