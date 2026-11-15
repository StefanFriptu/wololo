import type { DroppedStream, MediaStream, PlannedStream, StreamKind } from '#lib/shared.ts';
import type { StreamChange } from './StreamChange.ts';

export interface StreamRow {
  kind: StreamKind;
  before: MediaStream | null;
  planned: PlannedStream | null;
  after: MediaStream | null;
  change: StreamChange;
  dropReason: DroppedStream['reason'] | null;
}
