import type { MediaFileDetail } from '#lib/shared.ts';

/** The job whose before/after streams describe a file that needs no more work, or null when there is none. */
export function convertedByJob(file: Pick<MediaFileDetail, 'plan' | 'lastJobId'> | undefined): number | null {
  if (file?.plan?.action !== 'skip') return null;
  return file.lastJobId;
}
