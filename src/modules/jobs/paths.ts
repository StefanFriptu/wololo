import { createHash } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import { TEMP_FILE_MARKER } from '../../contracts/jobs.ts';
import type { MediaFileKind } from '../../shared/domain.ts';

const OUTPUT_EXTENSION = '.mkv';
const TEMP_SUFFIX = `${TEMP_FILE_MARKER}${OUTPUT_EXTENSION}`;
const NAME_MAX_BYTES = 255;

function stemOf(path: string): string {
  return basename(path, extname(path));
}

function truncateUtf8(text: string, maxBytes: number): string {
  let kept = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    kept += char;
    bytes += size;
  }
  return kept;
}

export function exceedsNameMax(path: string): boolean {
  return Buffer.byteLength(basename(path)) > NAME_MAX_BYTES;
}

/**
 * "<dir>/<stem>.wololo-tmp.mkv" next to the source, so the final rename never crosses filesystems. A stem too long for
 * NAME_MAX is shortened and suffixed with a hash of the full stem, so two long names never share a temp file.
 */
export function tempPathFor(sourcePath: string): string {
  const stem = stemOf(sourcePath);
  const name = `${stem}${TEMP_SUFFIX}`;
  if (Buffer.byteLength(name) <= NAME_MAX_BYTES) return join(dirname(sourcePath), name);
  const hash = createHash('sha256').update(stem).digest('hex').slice(0, 8);
  const tail = `~${hash}${TEMP_SUFFIX}`;
  return join(dirname(sourcePath), `${truncateUtf8(stem, NAME_MAX_BYTES - Buffer.byteLength(tail))}${tail}`);
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
