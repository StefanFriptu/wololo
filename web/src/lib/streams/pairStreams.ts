import type { ConversionPlan, DroppedStream, MediaStream, PlannedStream, StreamKind } from '#lib/shared.ts';

export type StreamChange = 'copy' | 'encode' | 'retag' | 'drop' | 'add' | 'none';

export interface StreamRow {
  kind: StreamKind;
  before: MediaStream | null;
  planned: PlannedStream | null;
  after: MediaStream | null;
  change: StreamChange;
  dropReason: DroppedStream['reason'] | null;
}

export interface PairStreamsInput {
  before: readonly MediaStream[] | null;
  plan: ConversionPlan | null;
  /** Streams of the written file, in output order (plan.streams order). */
  after?: readonly MediaStream[] | null;
}

function fromPlan(before: readonly MediaStream[], plan: ConversionPlan, after: readonly MediaStream[]): StreamRow[] {
  const source = (index: number) => before.find((stream) => stream.index === index) ?? null;
  const output = plan.streams.map((planned, position): StreamRow => {
    const written = after[position];
    return {
      kind: planned.kind,
      before: source(planned.sourceIndex),
      planned,
      after: written && written.kind === planned.kind ? written : null,
      change: planned.op === 'encode' ? 'encode' : planned.retagged ? 'retag' : 'copy',
      dropReason: null,
    };
  });
  const dropped = plan.dropped.map(
    (drop): StreamRow => ({
      kind: drop.kind,
      before: source(drop.sourceIndex),
      planned: null,
      after: null,
      change: 'drop',
      dropReason: drop.reason,
    }),
  );
  return [...output, ...dropped];
}

function byPosition(before: readonly MediaStream[], after: readonly MediaStream[] | null): StreamRow[] {
  const length = Math.max(before.length, after?.length ?? 0);
  return Array.from({ length }, (_, position): StreamRow => {
    const left = before[position] ?? null;
    const right = after?.[position] ?? null;
    const kind = (left ?? right)?.kind ?? 'data';
    let change: StreamChange = 'none';
    if (after && left && right) change = left.codec === right.codec ? 'copy' : 'encode';
    else if (after && left) change = 'drop';
    else if (right) change = 'add';
    return { kind, before: left, planned: null, after: right, change, dropReason: null };
  });
}

/**
 * Side-by-side rows for "before / after": with a plan, output streams in output order (matched to their source by
 * sourceIndex and to the written file by position), then dropped sources; without one, streams paired by position.
 */
export function pairStreams({ before, plan, after = null }: PairStreamsInput): StreamRow[] {
  const sources = before ?? [];
  if (plan) return fromPlan(sources, plan, after ?? []);
  return byPosition(sources, after);
}
