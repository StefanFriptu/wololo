import { z } from 'zod';
import type { ProfileInput } from '../../shared/api-types.ts';
import { DOLBY_VISION_MODES } from '../../shared/domain.ts';
import { codecAllowed } from '../rules/engine.ts';

const AC3_MAX_KBPS = 640;

const codecList = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]+\*?$/, 'expected an ffprobe codec name, optionally ending in "*"'),
  )
  .max(100)
  .transform((codecs) => [...new Set(codecs)]);

const bitrate = z.number().int().min(32).max(1536);

export const ProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  definition: z.object({
    audio: z
      .object({
        allowedCodecs: codecList,
        targetCodec: z.enum(['ac3', 'eac3', 'aac']),
        bitrates: z.object({ mono: bitrate, stereo: bitrate, surround: bitrate }),
        maxChannels: z.number().int().min(1).max(8),
      })
      .refine((audio) => codecAllowed(audio.targetCodec, audio.allowedCodecs), {
        message: 'targetCodec must be one of allowedCodecs, or converted tracks would never pass the profile',
        path: ['targetCodec'],
      })
      .refine((audio) => audio.targetCodec !== 'ac3' || Object.values(audio.bitrates).every((k) => k <= AC3_MAX_KBPS), {
        message: `AC3 bitrates cannot exceed ${AC3_MAX_KBPS} kbps`,
        path: ['bitrates'],
      }),
    video: z.object({
      allowedCodecs: codecList,
      dolbyVision: z.enum(DOLBY_VISION_MODES),
    }),
    subtitles: z.object({ allowedCodecs: codecList }),
    container: z.literal('mkv'),
  }),
}) satisfies z.ZodType<ProfileInput>;
