import type { AppContext } from '../../app/context.ts';
import type { RulesService } from '../../contracts/rules-ffmpeg.ts';
import { notImplemented } from '../../core/errors.ts';
import {
  computeRulesKey,
  planConversion,
  resolveEffectiveProfile,
} from './engine.ts';

export function createRulesService(_ctx: AppContext): RulesService {
  return {
    plan: planConversion,
    resolveProfile: resolveEffectiveProfile,
    rulesKey: computeRulesKey,
    effectiveProfileForLibrary: async () =>
      notImplemented('rules.effectiveProfileForLibrary'),
  };
}
