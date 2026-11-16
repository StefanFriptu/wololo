import type { JobLogChunk } from '#lib/shared.ts';

const NEWLINE = 0x0a;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function keepLast(view: JobLogChunk, maxBytes: number): JobLogChunk {
  const bytes = ENCODER.encode(view.text);
  if (bytes.length <= maxBytes) return view;
  const cut = bytes.indexOf(NEWLINE, bytes.length - maxBytes - 1) + 1;
  const kept = cut === 0 ? bytes.length : cut;
  return { ...view, text: DECODER.decode(bytes.subarray(kept)), start: view.start + kept };
}

/** Appends a chunk that continues the shown log, or replaces it when the server skipped ahead; keeps the last maxBytes. */
export function appendLogChunk(view: JobLogChunk | undefined, chunk: JobLogChunk, maxBytes: number): JobLogChunk {
  if (view === undefined || chunk.start !== view.end) return keepLast(chunk, maxBytes);
  if (chunk.text === '') return { ...view, size: chunk.size };
  return keepLast({ text: view.text + chunk.text, start: view.start, end: chunk.end, size: chunk.size }, maxBytes);
}
