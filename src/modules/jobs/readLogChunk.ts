import type { JobLogChunk } from '../../shared/api-types.ts';

const NEWLINE = 0x0a;
const DECODER = new TextDecoder();

/**
 * Reads whole lines of a log from byte `from` to its end, or only its last `maxBytes` when `from` is omitted, lies
 * past the end (the log was rewritten) or leaves more than `maxBytes` to read. The returned text never starts or ends
 * inside a line, so it cannot split a UTF-8 character and `end` is a safe `from` for the next call.
 */
export async function readLogChunk(path: string, options: { from?: number; maxBytes: number }): Promise<JobLogChunk> {
  const file = Bun.file(path);
  const size = file.size;
  const from = options.from;
  const resume = from !== undefined && from <= size && size - from <= options.maxBytes;
  const start = resume ? from : Math.max(0, size - options.maxBytes);
  const bytes = new Uint8Array(await file.slice(start, size).arrayBuffer());
  const head = !resume && start > 0 ? bytes.indexOf(NEWLINE) + 1 : 0;
  const tail = Math.max(head, bytes.lastIndexOf(NEWLINE) + 1);
  return { text: DECODER.decode(bytes.subarray(head, tail)), start: start + head, end: start + tail, size };
}
