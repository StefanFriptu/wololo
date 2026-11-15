import { basename, dirname, extname, join } from 'node:path';
import { TEMP_FILE_MARKER } from '../../contracts/jobs.ts';
import type { MediaFileKind } from '../../shared/domain.ts';

const OUTPUT_EXTENSION = '.mkv';

function stemOf(path: string): string {
  return basename(path, extname(path));
}

/** "<dir>/<stem>.wololo-tmp.mkv" next to the source, so the final rename never crosses filesystems. */
export function tempPathFor(sourcePath: string): string {
  return join(dirname(sourcePath), `${stemOf(sourcePath)}${TEMP_FILE_MARKER}${OUTPUT_EXTENSION}`);
}

/** Audio jobs always write Matroska: an .mkv source is replaced in place, any other container becomes "<stem>.mkv". */
export function outputPathFor(sourcePath: string): string {
  if (extname(sourcePath).toLowerCase() === OUTPUT_EXTENSION) return sourcePath;
  return join(dirname(sourcePath), `${stemOf(sourcePath)}${OUTPUT_EXTENSION}`);
}

export function isTempPath(path: string): boolean {
  return basename(path).includes(TEMP_FILE_MARKER);
}

export function jobTitleFor(path: string, kind: MediaFileKind): string {
  return kind === 'bdmv' ? basename(path) : stemOf(path);
}

export function jobLogPathFor(jobLogDir: string, jobId: number): string {
  return join(jobLogDir, `${jobId}.txt`);
}
