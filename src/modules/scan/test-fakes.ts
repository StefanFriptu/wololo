import { insertJob } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { JobsService, NewJob } from '../../contracts/jobs.ts';
import type { RulesService } from '../../contracts/rules-ffmpeg.ts';
import type { Db } from '../../db/client.ts';
import type { ConversionPlan, DeviceProfileDefinition, EffectiveProfile, JobSummary } from '../../shared/domain.ts';

export const TEST_DEFINITION: DeviceProfileDefinition = {
  audio: {
    allowedCodecs: ['ac3', 'aac', 'mp3'],
    targetCodec: 'ac3',
    bitrates: { mono: 192, stereo: 448, surround: 640 },
    maxChannels: 6,
  },
  video: { allowedCodecs: ['h264', 'hevc'], dolbyVision: 'drop_hdr10' },
  subtitles: { allowedCodecs: ['subrip'] },
  container: 'mkv',
};

/**
 * Minimal rules engine for probe-scan tests: audio outside the profile -> convert, video outside -> blocked.
 * Mutate `state.versionKey` to simulate a profile edit.
 */
export function fakeRules(state: { versionKey: string; definition?: DeviceProfileDefinition } = { versionKey: '1@1' }) {
  const effective = (): EffectiveProfile => ({
    profileIds: [1],
    versionKey: state.versionKey,
    definition: state.definition ?? TEST_DEFINITION,
  });
  return stubService<RulesService>('rules', {
    effectiveProfileForLibrary: async () => effective(),
    rulesKey: (profile, library) => `${profile.versionKey}|${library.mode}|${library.keepLanguages.join(',')}`,
    resolveProfile: (profiles) => ({
      profileIds: profiles.map((profile) => profile.id),
      versionKey: profiles.map((profile) => `${profile.id}@${profile.version}`).join('+'),
      definition: profiles[0]?.definition ?? TEST_DEFINITION,
    }),
    plan: ({ probe, profile, library }): ConversionPlan => {
      const failing = probe.streams
        .filter((stream) => stream.kind === 'audio' && !profile.definition.audio.allowedCodecs.includes(stream.codec))
        .map((stream) => stream.codec);
      const video = probe.streams.find((stream) => stream.kind === 'video');
      const blocked = video !== undefined && !profile.definition.video.allowedCodecs.includes(video.codec);
      const action = blocked ? 'blocked' : failing.length > 0 ? 'convert' : 'skip';
      return {
        action,
        reasons: [
          ...failing.map((codec) => `${codec} not decoded by profile`),
          ...(blocked && video ? [`video ${video.codec} not supported`] : []),
        ],
        failingCodecs: [...new Set([...failing, ...(blocked && video ? [video.codec] : [])])],
        streams: [],
        dropped: [],
        lostFeatures: [],
        videoNotes: [],
        estimatedOutputBytes: action === 'skip' ? null : Math.round(probe.sizeBytes * 0.9),
        rulesKey: `${profile.versionKey}|${library.mode}`,
      };
    },
  });
}

/** Records enqueue calls and inserts a queued jobs row, like the real (idempotent) queue. */
export function fakeJobs(db: () => Db, options: { fail?: boolean } = {}) {
  const calls: NewJob[] = [];
  const service = stubService<JobsService>('jobs', {
    enqueue: async (job) => {
      if (options.fail) throw new Error('queue unavailable');
      calls.push(job);
      const row = insertJob(db(), {
        sourcePath: `/job/${job.mediaFileId}`,
        mediaFileId: job.mediaFileId,
        type: job.type,
        trigger: job.trigger,
      });
      return { id: row.id, state: row.state } as JobSummary;
    },
  });
  return { service, calls };
}
