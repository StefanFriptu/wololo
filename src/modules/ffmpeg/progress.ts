import type { CreateProgressParser } from '../../contracts/rules-ffmpeg.ts';
import { notImplemented } from '../../core/errors.ts';

export const createProgressParser: CreateProgressParser = () =>
  notImplemented('createProgressParser');
