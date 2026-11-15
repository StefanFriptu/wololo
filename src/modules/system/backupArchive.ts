import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Unzip, UnzipInflate, Zip, ZipDeflate } from 'fflate';

export interface ArchiveEntry {
  name: string;
  sourcePath: string;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Streams files into a new zip (deflate) without holding them in memory; the output is created exclusively with
 * mode 0600 because backups contain the API key.
 */
export async function writeZipArchive(outPath: string, entries: readonly ArchiveEntry[]): Promise<void> {
  const fd = openSync(outPath, 'wx', 0o600);
  let failure: Error | null = null;
  let complete = false;
  const zip = new Zip((error, chunk, final) => {
    if (failure) return;
    if (error) {
      failure = error;
      return;
    }
    try {
      writeSync(fd, chunk);
      complete = final;
    } catch (writeError) {
      failure = asError(writeError);
    }
  });
  try {
    for (const entry of entries) {
      const file = new ZipDeflate(entry.name, { level: 6 });
      zip.add(file);
      for await (const chunk of Bun.file(entry.sourcePath).stream()) {
        file.push(chunk);
        if (failure) throw failure;
      }
      file.push(new Uint8Array(0), true);
    }
    zip.end();
    if (failure) throw failure;
    if (!complete) throw new Error('zip archive was not finalised');
  } finally {
    closeSync(fd);
  }
}

/**
 * Extracts only the named entries (each with a byte limit, which also guards against zip bombs) into targetDir.
 * Entry names are matched exactly, so no entry can write outside targetDir. Returns the names extracted.
 */
export async function extractZipEntries(
  chunks: AsyncIterable<Uint8Array>,
  targetDir: string,
  maxBytes: Readonly<Record<string, number>>,
): Promise<string[]> {
  const open = new Map<string, number>();
  const finished = new Set<string>();
  let failure: Error | null = null;
  const close = (name: string) => {
    const fd = open.get(name);
    if (fd === undefined) return;
    open.delete(name);
    closeSync(fd);
  };

  const unzip = new Unzip((file) => {
    const limit = maxBytes[file.name];
    if (limit === undefined || failure) return;
    if (open.has(file.name) || finished.has(file.name)) {
      failure = new Error(`archive contains ${file.name} twice`);
      return;
    }
    open.set(file.name, openSync(join(targetDir, file.name), 'wx', 0o600));
    let written = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = error;
        return;
      }
      written += chunk.length;
      if (written > limit) {
        failure = new Error(`${file.name} is larger than ${limit} bytes`);
        file.terminate();
        return;
      }
      try {
        writeSync(open.get(file.name) as number, chunk);
      } catch (writeError) {
        failure = asError(writeError);
        return;
      }
      if (!final) return;
      close(file.name);
      finished.add(file.name);
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    for await (const chunk of chunks) {
      unzip.push(chunk);
      if (failure) throw failure;
    }
    unzip.push(new Uint8Array(0), true);
    if (failure) throw failure;
    const truncated = [...open.keys()];
    if (truncated.length > 0) throw new Error(`archive ends inside ${truncated.join(', ')}`);
    return [...finished];
  } finally {
    for (const name of [...open.keys()]) close(name);
  }
}
