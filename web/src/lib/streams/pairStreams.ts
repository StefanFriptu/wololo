import type { ConversionPlan, MediaStream } from '#lib/shared.ts';
import type { StreamChange } from './StreamChange.ts';
import type { StreamRow } from './StreamRow.ts';

interface PairStreamsInput {
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

export function pairStreams({ before, plan, after = null }: PairStreamsInput): StreamRow[] {
  const sources = before ?? [];
  if (plan && (plan.streams.length > 0 || plan.dropped.length > 0)) return fromPlan(sources, plan, after ?? []);
  return byPosition(sources, after);
}
