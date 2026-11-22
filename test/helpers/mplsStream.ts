import type { MplsStream } from '../../src/contracts/bdmv.ts';

export function mplsStream(kind: MplsStream['kind'], overrides: Partial<MplsStream> = {}): MplsStream {
  return { kind, pid: 0, codingType: 0, codec: '', language: null, secondaryVideo: false, ...overrides };
}
