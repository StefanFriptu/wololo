import type { ClassifyEntry, NeedsRecheck } from '../../contracts/probe-scan.ts';
import { notImplemented } from '../../core/errors.ts';

export const needsRecheck: NeedsRecheck = () => notImplemented('needsRecheck');

export const classifyEntry: ClassifyEntry = () => notImplemented('classifyEntry');
