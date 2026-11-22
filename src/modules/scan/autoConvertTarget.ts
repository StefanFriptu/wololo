import type { MediaFileStatus, ProfileResult } from '../../shared/domain.ts';
import type { Settings } from '../../shared/settings.ts';

export interface AutoConvertInput {
  media: Pick<Settings['media'], 'importAction' | 'importProfileId'>;
  libraryProfileIds: readonly number[];
  status: MediaFileStatus;
  /** null for discs, which always convert for the strictest combination. */
  profileResults: readonly ProfileResult[] | null;
}

/**
 * The job a webhook import or a scan queues for a checked file, per Settings.media.importAction: null = queue nothing,
 * profileId null = convert for the strictest combination of the library's profiles.
 */
export function autoConvertTarget(input: AutoConvertInput): { profileId: number | null } | null {
  const { media, status } = input;
  switch (media.importAction) {
    case 'check_only':
      return null;
    case 'convert_strictest':
      return status === 'needs_work' ? { profileId: null } : null;
    case 'convert_for_profile': {
      const profileId = media.importProfileId;
      if (profileId === null || !input.libraryProfileIds.includes(profileId)) return null;
      if (input.profileResults === null) return status === 'needs_work' ? { profileId: null } : null;
      const result = input.profileResults.find((candidate) => candidate.profileId === profileId);
      return result?.action === 'convert' || result?.action === 'remux' ? { profileId } : null;
    }
    default: {
      const unreachable: never = media.importAction;
      throw new Error(`unknown import action ${unreachable}`);
    }
  }
}
