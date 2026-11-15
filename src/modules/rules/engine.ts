import type {
  CodecAllowed,
  ComputeRulesKey,
  PlanConversion,
  ResolveEffectiveProfile,
} from '../../contracts/rules-ffmpeg.ts';
import { notImplemented } from '../../core/errors.ts';

export const codecAllowed: CodecAllowed = () => notImplemented('codecAllowed');

export const resolveEffectiveProfile: ResolveEffectiveProfile = () =>
  notImplemented('resolveEffectiveProfile');

export const computeRulesKey: ComputeRulesKey = () =>
  notImplemented('computeRulesKey');

export const planConversion: PlanConversion = () =>
  notImplemented('planConversion');
