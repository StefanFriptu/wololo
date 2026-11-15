import type { BuildAudioConversionArgs, SelectBitrate } from '../../contracts/rules-ffmpeg.ts';
import { notImplemented } from '../../core/errors.ts';

export const selectBitrate: SelectBitrate = () => notImplemented('selectBitrate');

export const buildAudioConversionArgs: BuildAudioConversionArgs = () => notImplemented('buildAudioConversionArgs');
