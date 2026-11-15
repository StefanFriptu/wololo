import type {
  DedupePlaylists,
  DetectEncryption,
  PickMainTitle,
} from '../../contracts/bdmv.ts';
import { notImplemented } from '../../core/errors.ts';

export const dedupePlaylists: DedupePlaylists = () =>
  notImplemented('dedupePlaylists');

export const pickMainTitle: PickMainTitle = () =>
  notImplemented('pickMainTitle');

export const detectEncryption: DetectEncryption = () =>
  notImplemented('detectEncryption');
