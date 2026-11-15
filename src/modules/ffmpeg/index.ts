import type { AppContext } from '../../app/context.ts';
import type { FfmpegService } from '../../contracts/rules-ffmpeg.ts';
import { buildAudioConversionArgs } from './args.ts';
import { createProgressParser } from './progress.ts';

export function createFfmpegService(_ctx: AppContext): FfmpegService {
  return { buildAudioConversionArgs, createProgressParser };
}
