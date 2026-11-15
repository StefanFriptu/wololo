import type { PlanAction } from '../../shared/domain.ts';

/** Sustained read+write throughput of a copy/remux on a USB disk attached to a Pi 4 (bytes per second). */
export const COPY_BYTES_PER_SECOND = 40 * 1024 * 1024;

export interface EstimateInput {
  planAction: PlanAction | null;
  durationSec: number | null;
  sizeBytes: number;
  estimatedOutputBytes: number | null;
}

/**
 * Pure: seconds a job takes. Every job rewrites the whole file (I/O bound); encoding audio is bounded by the speed
 * factor (multiple of real time). Disc rows are remuxed from the playlist and encode audio in the same pass.
 */
export function estimateJobSeconds(input: EstimateInput, speedFactor: number): number {
  const ioSeconds = Math.max(input.sizeBytes, input.estimatedOutputBytes ?? 0) / COPY_BYTES_PER_SECOND;
  const encodes = input.planAction === 'convert';
  const encodeSeconds = encodes && input.durationSec && speedFactor > 0 ? input.durationSec / speedFactor : 0;
  return Math.round(Math.max(ioSeconds, encodeSeconds));
}

export function estimateOutputBytes(input: EstimateInput): number {
  return input.estimatedOutputBytes ?? input.sizeBytes;
}

/** Peak extra space for one root: the largest temp output plus the free-space margin jobs require. */
export function peakTempBytes(largestOutputBytes: number, marginPercent: number): number {
  return Math.round(largestOutputBytes * (1 + marginPercent / 100));
}
