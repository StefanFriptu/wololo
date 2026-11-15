import type { CheckAction } from '../../contracts/probe-scan.ts';
import type { ConversionPlan, MediaFileStatus, ProbeResult } from '../../shared/domain.ts';

export interface ProbeSummary {
  videoCodec: string | null;
  audioCodecs: string[];
  subtitleLanguages: string[];
}

export function summarizeProbe(probe: ProbeResult): ProbeSummary {
  const unique = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))];
  const video = probe.streams.find((stream) => stream.kind === 'video' && !stream.attachedPicture);
  return {
    videoCodec: video?.codec ?? null,
    audioCodecs: unique(probe.streams.filter((stream) => stream.kind === 'audio').map((stream) => stream.codec)),
    subtitleLanguages: unique(
      probe.streams.filter((stream) => stream.kind === 'subtitle').map((stream) => stream.language),
    ),
  };
}

export function statusFromPlan(plan: ConversionPlan): { status: MediaFileStatus; reason: string | null } {
  const reasons = plan.reasons.join('; ');
  switch (plan.action) {
    case 'skip':
      return { status: 'compatible', reason: null };
    case 'remux':
    case 'convert':
      return { status: 'needs_work', reason: reasons || null };
    case 'blocked':
      return { status: 'blocked', reason: `blocked: ${reasons || 'needs work that cannot be done automatically'}` };
    default: {
      const unreachable: never = plan.action;
      throw new Error(`unknown plan action ${unreachable}`);
    }
  }
}

/** Action reported for a row that was evaluated without queueing a job. */
export function checkActionFor(status: MediaFileStatus): CheckAction {
  switch (status) {
    case 'compatible':
      return 'compatible';
    case 'needs_work':
      return 'dry_run';
    case 'blocked':
      return 'blocked';
    case 'ignored':
      return 'ignored';
    case 'processing':
      return 'queued';
    case 'pending':
    case 'failed':
      return 'failed';
    default: {
      const unreachable: never = status;
      throw new Error(`unknown status ${unreachable}`);
    }
  }
}
