import type { CheckAction } from '../../contracts/probe-scan.ts';
import type { ConversionPlan, MediaFileStatus, PlanAction, ProbeResult } from '../../shared/domain.ts';

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

/** Blocked plans need work that cannot be done automatically: the row is "failed" so no job picks it up. */
export function statusFromPlan(plan: ConversionPlan): { status: MediaFileStatus; reason: string | null } {
  const reasons = plan.reasons.join('; ');
  switch (plan.action) {
    case 'skip':
      return { status: 'compatible', reason: null };
    case 'remux':
    case 'convert':
      return { status: 'needs_work', reason: reasons || null };
    case 'blocked':
      return { status: 'failed', reason: `blocked: ${reasons || 'needs work that cannot be done automatically'}` };
    default: {
      const unreachable: never = plan.action;
      throw new Error(`unknown plan action ${unreachable}`);
    }
  }
}

/** Action reported for a row that was evaluated without queueing a job. */
export function checkActionFor(status: MediaFileStatus, planAction: PlanAction | null): CheckAction {
  if (planAction === 'blocked' && status === 'failed') return 'blocked';
  switch (status) {
    case 'compatible':
      return 'compatible';
    case 'needs_work':
      return 'dry_run';
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
